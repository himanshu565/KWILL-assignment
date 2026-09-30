import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg"],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
