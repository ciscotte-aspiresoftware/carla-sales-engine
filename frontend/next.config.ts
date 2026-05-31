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
};

export default nextConfig;
