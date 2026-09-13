import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 127.0.0.1 is used in dev to escape the localhost cookie jar (other apps bloat it).
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  /* config options here */
};

export default nextConfig;
