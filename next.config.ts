import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 127.0.0.1 is used in dev to escape the localhost cookie jar (other apps bloat it).
  // *.trycloudflare.com is the dev tunnel (npm run spike:tunnel): without it the
  // pages load through the tunnel but never hydrate, so no form works.
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.trycloudflare.com"],
  /* config options here */
};

export default nextConfig;
