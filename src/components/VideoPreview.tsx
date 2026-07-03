"use client";

import type { CSSProperties } from "react";
import { PROVIDER_LABEL, type VideoEmbed } from "@/lib/video";

const fill: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%" };

/**
 * Video preview for a parsed video URL. Direct files play inline; provider
 * videos (YouTube/Vimeo/…) render as a poster with a play button that opens
 * the video on the provider's site in a new tab. We deliberately don't play
 * in an embedded player — YouTube refuses embedded playback in many contexts
 * ("Error 153"), so the watch page is the reliable path.
 * The parent element provides the aspect-ratio box (position: relative).
 */
export default function VideoPreview({ embed, title }: { embed: VideoEmbed; title: string }) {
  if (embed.kind === "file") {
    return (
      <video src={embed.src} controls playsInline preload="metadata" style={{ ...fill, objectFit: "contain", background: "#0d1320", border: 0 }} />
    );
  }

  return (
    <a
      href={embed.watchUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Play video on ${PROVIDER_LABEL[embed.provider]}: ${title}`}
      style={{
        ...fill,
        display: "block",
        background: "linear-gradient(135deg, #1b2436, #0d1320)",
        overflow: "hidden",
      }}
    >
      {embed.thumbnail && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={embed.thumbnail} alt="" loading="lazy" style={{ ...fill, objectFit: "cover" }} />
      )}
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "rgba(13, 19, 32, 0.78)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
        }}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="#fff" style={{ marginLeft: 3 }}>
          <path d="M8 5.5v13l11-6.5z" />
        </svg>
      </span>
      <span
        style={{
          position: "absolute",
          right: 8,
          bottom: 8,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.04em",
          color: "#fff",
          background: "rgba(13, 19, 32, 0.7)",
          borderRadius: 4,
          padding: "3px 7px",
        }}
      >
        Watch on {PROVIDER_LABEL[embed.provider]}
      </span>
    </a>
  );
}
