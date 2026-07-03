// Turn a pasted video URL into something previewable. Providers get an iframe
// embed URL; direct video files play in a native <video> element.
export type VideoProvider = "youtube" | "vimeo" | "loom" | "drive" | "file";

export type VideoEmbed = {
  kind: "iframe" | "file";
  provider: VideoProvider;
  /** Embed/player URL. */
  src: string;
  /** Poster image, when derivable without an API call. */
  thumbnail?: string;
  /** The video's page on the provider — where the play button links to. */
  watchUrl: string;
};

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
      const hash = parts[i + 1] && /^[0-9a-f]+$/i.test(parts[i + 1]) ? parts[i + 1] : null;
      const src = `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ""}`;
      return {
        kind: "iframe",
        provider: "vimeo",
        src,
        watchUrl: `https://vimeo.com/${id}${hash ? `/${hash}` : ""}`,
      };
    }
    if (host === "loom.com" || host.endsWith(".loom.com")) {
      const m = u.pathname.match(/\/(?:share|embed)\/([0-9a-f]+)/i);
      if (!m?.[1]) return null;
      const src = `https://www.loom.com/embed/${m[1]}`;
      return {
        kind: "iframe",
        provider: "loom",
        src,
        watchUrl: `https://www.loom.com/share/${m[1]}`,
      };
    }
    if (host === "drive.google.com") {
      const m = u.pathname.match(/\/file\/d\/([^/]+)/);
      if (!m?.[1]) return null;
      const src = `https://drive.google.com/file/d/${m[1]}/preview`;
      return { kind: "iframe", provider: "drive", src, watchUrl: `https://drive.google.com/file/d/${m[1]}/view` };
    }
    if (FILE_EXT.test(u.pathname)) {
      const s = u.toString();
      return { kind: "file", provider: "file", src: s, watchUrl: s };
    }
  } catch {
    /* not a URL */
  }
  return null;
}

function yt(rawId: string): VideoEmbed {
  const id = encodeURIComponent(rawId);
  return {
    kind: "iframe",
    provider: "youtube",
    src: `https://www.youtube.com/embed/${id}`,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    watchUrl: `https://www.youtube.com/watch?v=${id}`,
  };
}

export const PROVIDER_LABEL: Record<VideoProvider, string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  loom: "Loom",
  drive: "Google Drive",
  file: "video",
};

export function isHttpUrl(v: string): boolean {
  return /^https?:\/\/\S+$/i.test(v.trim());
}
