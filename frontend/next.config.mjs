/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    let rawBackendUrl = (process.env.BACKEND_INTERNAL_URL || "http://localhost:3001").trim();
    // Strip surrounding quotes if accidentally included
    rawBackendUrl = rawBackendUrl.replace(/^['"]|['"]$/g, "");
    // Enforce https:// for any remote host (e.g. *.up.railway.app) to prevent 301 redirects that break POST requests
    if (rawBackendUrl && !rawBackendUrl.includes("localhost") && !rawBackendUrl.includes("127.0.0.1")) {
      rawBackendUrl = rawBackendUrl.replace(/^http:\/\//i, "https://");
      if (!rawBackendUrl.startsWith("https://")) {
        rawBackendUrl = `https://${rawBackendUrl}`;
      }
    } else if (rawBackendUrl && !rawBackendUrl.startsWith("http://") && !rawBackendUrl.startsWith("https://")) {
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
