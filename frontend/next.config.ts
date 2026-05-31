import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Rewrites `import { Icon } from "lucide-react"` to deep imports under
    // the hood (`import Icon from "lucide-react/dist/esm/icons/icon"`).
    // Each page only ships the icon code it actually uses — drops dev
    // compile time and per-page bundle size noticeably for an app this
    // icon-heavy.
    optimizePackageImports: ["lucide-react"],
  },
  // Proxy all /api/v1/* requests through the Next.js server to the backend.
  // In development, BACKEND_URL defaults to http://localhost:8000.
  // In production (Vercel), set BACKEND_URL=https://<your-railway-url>.
  // This eliminates CORS entirely — the browser only ever talks to the
  // same origin as the frontend.
  async rewrites() {
    const backendUrl =
      process.env.BACKEND_URL || "http://localhost:8000";
    return [
      {
        source: "/api/v1/:path*",
        destination: `${backendUrl}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
