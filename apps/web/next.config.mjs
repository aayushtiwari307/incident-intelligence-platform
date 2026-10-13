import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Needed for a small production container; keep tracing anchored at the npm-workspace root so
  // the standalone server includes the compiled @platform/shared workspace files.
  output: "standalone",
  outputFileTracingRoot: path.join(here, "../.."),
  transpilePackages: ["@platform/shared"],
};
export default nextConfig;
