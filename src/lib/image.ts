"use client";

import { MAX_LAYER_IMAGE_BYTES } from "./const";

/**
 * Gets an operator's site-plan render small enough to upload, without asking
 * them to know or care what it weighs.
 *
 * The constraint that shapes all of this: an overlay image is one indivisible
 * blob. GeoJSON import dodges the Amplify SSR Lambda's ~6 MB body cap by
 * batching; an image can't be split, so it has to be *small before it's sent*.
 * And an oversized body is dropped silently — to the operator that reads as
 * "the upload just doesn't work" — so when we genuinely can't get under the cap
 * we fail loudly with a number they can act on.
 *
 * Transparency is load-bearing, not a nicety: a river or a lake cut out of a
 * PNG is a completely normal thing to pin over satellite imagery, and flattening
 * it onto white would ruin the overlay. So the encoder is chosen by whether the
 * image actually has alpha:
 *
 *   • opaque  → JPEG. Best compression per pixel, and nothing to lose.
 *   • alpha   → WebP, which keeps the alpha channel and still compresses far
 *               better than PNG. PNG is the fallback where WebP encoding isn't
 *               available; it's much bigger, so those images downscale further.
 */

export type PreparedImage = {
  /** Base64, no data: prefix — what POST /layers wants. */
  data: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  originalBytes: number;
  /** True when we had to shrink or recompress to fit. Surfaced in the UI. */
  reduced: boolean;
};

// Longest-edge ladder. Registration accuracy matters more than compression
// artifacts on a map overlay, so we give up pixels only after giving up quality.
const EDGES = [4096, 3072, 2560, 2048, 1536, 1200];
const QUALITIES = [0.9, 0.78, 0.65, 0.5];

export class ImageTooLargeError extends Error {}

export async function prepareLayerImage(file: File): Promise<PreparedImage> {
  const bitmap = await decode(file);
  const hasAlpha = file.type === "image/jpeg" ? false : detectAlpha(bitmap);

  for (const edge of EDGES) {
    const { canvas, width, height } = drawScaled(bitmap, edge);
    for (const quality of QUALITIES) {
      const blob = await encode(canvas, hasAlpha, quality);
      if (!blob) continue;
      if (blob.size <= MAX_LAYER_IMAGE_BYTES) {
        release(bitmap);
        return {
          data: await toBase64(blob),
          mime: blob.type,
          width,
          height,
          bytes: blob.size,
          originalBytes: file.size,
          reduced: blob.size !== file.size || width !== bitmap.width,
        };
      }
      // PNG has no quality knob — retrying the same canvas is pointless, so
      // drop straight to the next size down.
      if (blob.type === "image/png") break;
    }
  }

  release(bitmap);
  throw new ImageTooLargeError(
    `This image is ${mb(file.size)} MB and still won't fit under ${mb(MAX_LAYER_IMAGE_BYTES)} MB after resizing. ` +
      `Export it at a lower resolution or save it as a JPEG first, then try again.`
  );
}

/** createImageBitmap is the fast path; some Safari builds refuse certain types. */
async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = "async";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("That file couldn't be read as an image."));
        img.src = url;
      });
      return img;
    } finally {
      // The bitmap is already decoded into the element by the time we draw it.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }
}

type Source = ImageBitmap | HTMLImageElement;

/** Free the decoded bitmap where the platform gives us the option. */
function release(src: Source) {
  if ("close" in src) src.close();
}

const dims = (s: Source) => ({
  w: "naturalWidth" in s ? s.naturalWidth : s.width,
  h: "naturalHeight" in s ? s.naturalHeight : s.height,
});

/**
 * Any transparency at all? Sampled from a small thumbnail rather than the full
 * image: a 4096² getImageData allocates ~67 MB, which is a real risk on a phone.
 * Meaningful transparency (a cut-out river, a knocked-out background) covers far
 * more than one 256th of the frame, so the thumbnail sees it. What this can miss
 * is sub-pixel edge alpha — invisible on a map overlay either way.
 */
function detectAlpha(src: Source): boolean {
  const { w, h } = dims(src);
  const scale = Math.min(1, 256 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return true; // can't tell → assume alpha, which never destroys data
  ctx.drawImage(src as CanvasImageSource, 0, 0, cw, ch);
  const { data } = ctx.getImageData(0, 0, cw, ch);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

function drawScaled(src: Source, maxEdge: number) {
  const { w, h } = dims(src);
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const width = Math.max(1, Math.round(w * scale));
  const height = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser wouldn't give us a canvas to resize the image on.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src as CanvasImageSource, 0, 0, width, height);
  return { canvas, width, height };
}

/**
 * Encode, honoring alpha. Browsers silently fall back to PNG when asked for a
 * format they can't write, so the result's own `type` is what we trust — never
 * the type we requested.
 */
async function encode(canvas: HTMLCanvasElement, hasAlpha: boolean, quality: number) {
  const type = hasAlpha ? "image/webp" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, quality)
  );
  if (!blob) return null;
  // A JPEG fallback for an alpha image would flatten transparency to black, so
  // if WebP wasn't available insist on PNG instead.
  if (hasAlpha && blob.type !== "image/webp" && blob.type !== "image/png") {
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  }
  return blob;
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read the resized image."));
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.slice(s.indexOf("base64,") + 7));
    };
    reader.readAsDataURL(blob);
  });
}

export function mb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}
