import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // The UI is pure rendering over the API's SSE stream (PLAN.md §5/M2) and holds
  // no server state of its own, so there is nothing here to configure yet.
  reactStrictMode: true,
  // Next writes its own AGENTS.md/CLAUDE.md on first dev run. The repo already has
  // a hand-written CLAUDE.md at the root that is the actual rules digest, and a
  // second generated one here would compete with it.
  agentRules: false,
  turbopack: {
    // The API's lockfile sits one directory up, and Next would otherwise infer the
    // repo root as this app's root and warn on every build.
    root: dirname(fileURLToPath(import.meta.url)),
  },
};

export default config;
