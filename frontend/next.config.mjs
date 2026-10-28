/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    let rawBackendUrl = (process.env.BACKEND_INTERNAL_URL || "http://localhost:3001").trim();
    // Strip surrounding quotes if accidentally included
    rawBackendUrl = rawBackendUrl.replace(/^['"]|['"]$/g, "");
    // If protocol is missing (e.g. pasted directly from Railway as domain.up.railway.app), auto-prepend https://
    if (rawBackendUrl && !rawBackendUrl.startsWith("http://") && !rawBackendUrl.startsWith("https://")) {
      rawBackendUrl = `https://${rawBackendUrl}`;
    }
    const backendUrl = rawBackendUrl.replace(/\/+$/, "");
    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: "/v1/:path*",
        destination: `${backendUrl}/v1/:path*`,
      },
      {
        source: "/metrics",
        destination: `${backendUrl}/metrics`,
      },
      {
        source: "/health",
        destination: `${backendUrl}/health`,
      },
    ];
  },
};

export default nextConfig;
