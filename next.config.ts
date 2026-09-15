import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // API routes read bundled demo runs and saved evidence snapshots from disk at
  // request time; the tracer cannot see those fs reads, so ship them explicitly.
  outputFileTracingIncludes: {
    "/api/*": ["./data/demo/**/*.json", "./data/evidence/**/*.json"],
  },
};

export default nextConfig;
