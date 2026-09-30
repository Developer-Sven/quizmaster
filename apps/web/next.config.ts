import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

function findRepoRoot(start: string): string {
  let dir = start;
  while (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
  return dir;
}

const repoRoot = findRepoRoot(process.cwd());

const nextConfig: NextConfig = {
  reactCompiler: true,
  poweredByHeader: false,
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  transpilePackages: ["@quizmaster/shared", "@quizmaster/db"],
  // Eigenes Build-Verzeichnis je paralleler Instanz (z. B. Agents/E2E), Standard .next
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
