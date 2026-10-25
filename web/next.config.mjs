import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// This deployment can be reached through a path rewrite on app.agama.finance
// (/solana). The pages live at /solana so the rewrite is a straight pass
// through, but the assets would land on app.agama.finance/_next and collide
// with the product app's own bundle. Serving them from this deployment's own
// origin keeps the two apart.
const assetPrefix = process.env.NEXT_PUBLIC_ASSET_PREFIX || undefined;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `pnpm typecheck` is the type gate (tsconfig.solana.json), so the build
  // does not run it a second time.
  typescript: { ignoreBuildErrors: true },
  assetPrefix,
  // A second build can sit beside the served one (the e2e builds into its own
  // directory while launchd keeps serving .next).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // The Anchor repo sits one level up and has its own lockfile; pin the root
  // so Next does not walk up and pick it.
  outputFileTracingRoot: root,
  turbopack: { root },
  // Every page here is a client component that reads the chain on mount, so the
  // server payload is the same shell whichever tab you are on. Without this the
  // router treats it as dynamic, throws it away immediately and refetches it on
  // every tab click, which is a round trip in front of a page that has all of
  // its real data still to fetch.
  experimental: { staleTimes: { dynamic: 120, static: 300 } },
};

export default nextConfig;
