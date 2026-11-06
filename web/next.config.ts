import type { NextConfig } from "next";

// Functions that route need the Fiji road graph (data/fiji-roads.bin, built by
// scripts/routing/build-graph.py); only they carry it.
const roadGraph = ["./data/fiji-roads.bin"];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: { root: import.meta.dirname },
  outputFileTracingIncludes: {
    "/api/routes/plan": roadGraph,
    "/api/routes/sequence": roadGraph,
    "/api/navigation/route": roadGraph,
    "/routes/[id]": roadGraph,
  },
};

export default nextConfig;
