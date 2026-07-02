import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships WASM assets; keep it external so the bundler doesn't mangle it.
  serverExternalPackages: ["@electric-sql/pglite"],
  // Pin the workspace root (a stray lockfile in $HOME otherwise confuses Turbopack).
  turbopack: { root: __dirname },
};

export default nextConfig;
