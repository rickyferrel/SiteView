import type { NextConfig } from "next";

// Space-separated list of origins allowed to embed /embed/* in an <iframe>
// (the WordPress site), e.g. "https://example.com https://www.example.com".
// When unset, the embed is frameable anywhere (dev-friendly default). Set
// EMBED_FRAME_ANCESTORS in the Amplify environment to lock the iframe to prod.
const frameAncestors = process.env.EMBED_FRAME_ANCESTORS?.trim();

const nextConfig: NextConfig = {
  // PGlite ships WASM assets; keep it external so the bundler doesn't mangle it.
  serverExternalPackages: ["@electric-sql/pglite"],
  // Pin the workspace root (a stray lockfile in $HOME otherwise confuses Turbopack).
  turbopack: { root: __dirname },
  async headers() {
    if (!frameAncestors) return [];
    return [
      {
        source: "/embed/:slug*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors ${frameAncestors};`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
