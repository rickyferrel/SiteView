// Turn a pasted video URL into something previewable. Providers get an iframe
// embed URL; direct video files play in a native <video> element.
export type VideoEmbed = { kind: "iframe" | "file"; src: string };

const FILE_EXT = /\.(mp4|webm|ogv|ogg|mov|m4v)(\?|#|$)/i;

export function videoEmbed(url?: string | null): VideoEmbed | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return id ? yt(id) : null;
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      const id = u.searchParams.get("v");
      if (id) return yt(id);
      const m = u.pathname.match(/\/(shorts|live|embed|v)\/([^/?#]+)/);
      return m?.[2] ? yt(m[2]) : null;
    }
    if (host === "vimeo.com" || host === "player.vimeo.com") {
      // vimeo.com/{id}, vimeo.com/{id}/{hash} (unlisted), player.vimeo.com/video/{id}
      const parts = u.pathname.split("/").filter(Boolean);
      const i = parts[0] === "video" ? 1 : 0;
      const id = parts[i];
      if (!id || !/^\d+$/.test(id)) return null;
      const hash = parts[i + 1] && /^[0-9a-f]+$/i.test(parts[i + 1]) ? `?h=${parts[i + 1]}` : "";
      return { kind: "iframe", src: `https://player.vimeo.com/video/${id}${hash}` };
    }
    if (host === "loom.com" || host.endsWith(".loom.com")) {
      const m = u.pathname.match(/\/(?:share|embed)\/([0-9a-f]+)/i);
      return m?.[1] ? { kind: "iframe", src: `https://www.loom.com/embed/${m[1]}` } : null;
    }
    if (host === "drive.google.com") {
      const m = u.pathname.match(/\/file\/d\/([^/]+)/);
      return m?.[1] ? { kind: "iframe", src: `https://drive.google.com/file/d/${m[1]}/preview` } : null;
    }
    if (FILE_EXT.test(u.pathname)) return { kind: "file", src: u.toString() };
  } catch {
    /* not a URL */
  }
  return null;
}

function yt(id: string): VideoEmbed {
  return { kind: "iframe", src: `https://www.youtube.com/embed/${encodeURIComponent(id)}` };
}

export function isHttpUrl(v: string): boolean {
  return /^https?:\/\/\S+$/i.test(v.trim());
}
