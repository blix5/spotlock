import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app must be opened at 127.0.0.1, not localhost: SPOTIFY_REDIRECT_URI
  // is registered as http://127.0.0.1:3000/api/auth/callback and Spotify
  // requires an exact match. But `next dev` treats localhost as the origin it
  // was initialised with, so requests from 127.0.0.1 count as cross-origin and
  // dev-only resources (/_next/hmr) get blocked - which breaks hydration, so
  // no Client Component ever mounts.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
