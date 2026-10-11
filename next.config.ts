import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The demo site lives under /demo-site/ with relative links, so its trailing slash must survive.
  skipTrailingSlashRedirect: true,
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
