import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * API routes read bundled demo runs, evidence snapshots and country scans
   * from disk at request time; the tracer cannot see those fs reads, so they
   * are shipped explicitly.
   *
   * Listed per route rather than as one `/api/*` glob. The demo snapshots carry
   * full simulation replays and run to 6.9 MB, and a single glob copies all of
   * it into every function — geocode and partners included, neither of which
   * reads a byte of it. Vercel bundles and cold-starts each function
   * separately, so that is paid per route, not once.
   */
  outputFileTracingIncludes: {
    "/api/analyze": ["./data/demo/**/*.json", "./data/evidence/**/*.json"],
    "/api/brief": ["./data/demo/**/*.json"],
    "/api/cached-run": ["./data/demo/**/*.json"],
    "/api/match": ["./data/demo/**/*.json"],
    "/api/scan": ["./data/scan/**/*.json"],
  },
};

export default nextConfig;
