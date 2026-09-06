# throughline — API image (PLAN.md §9)
#
# Two properties this file exists to hold, both of which §9 asks for and neither
# of which is free:
#
#   1. **The index is baked in.** The corpus is fixed and read-only, so the
#      sqlite-vec index is built here and shipped inside the image. Every free
#      host in §9's table has an ephemeral filesystem, so a container that
#      indexed at boot would re-embed 172 documents on every cold start — against
#      a free tier that answers ~20 requests per window. On Render's free plan a
#      cold start is every fifteen idle minutes, which would make the instance
#      rate-limited into uselessness rather than merely slow.
#
#   2. **The build needs no key and no network.** §11.4 originally kept that by
#      locking embeddings to a local in-process model; that decision was
#      superseded and the local provider was never written. `corpus/index/
#      embeddings.json` restores the property instead — the vectors are the only
#      part of the index that cannot be recomputed offline, and everything else
#      is already in git. `EMBEDDING_PROVIDER=precomputed` replays them.
#
# The image builds a *fresh* database rather than copying a developer's, which
# is what keeps ~9.6MB of local traces, checkpoints and pending writes out of it
# — the trap §9 flags. There is nothing to remember to clear because nothing is
# carried over. Measured: 3.5MB, 172/172 documents, 0.8s, zero model calls.
#
# Host-neutral on purpose. `PORT` comes from the environment, which every
# candidate platform injects, so the same image runs on Render, Northflank,
# Cloud Run or a Hugging Face Space.
#
#   docker build -t throughline .
#   docker run --rm -p 7860:7860 -e GEMINI_API_KEY=... -e EMBEDDING_API_KEY=... throughline

# --- builder -----------------------------------------------------------------
# Debian rather than Alpine: `better-sqlite3` is a native module and `sqlite-vec`
# ships prebuilt binaries, and both target glibc. On musl the first is compiled
# from source and the second has no matching artifact at all.
FROM node:22-bookworm-slim AS builder

# `better-sqlite3` builds from source when no prebuilt matches the running Node
# ABI, and node-gyp needs all three of these to do it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Lockfile first, so a source-only change does not re-resolve the dependency
# tree. `--frozen-lockfile` for the same reason CI uses it: a build that quietly
# updates a dependency is not reproducing anything.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
COPY corpus ./corpus

RUN pnpm build

# Built here, with dev dependencies present, because the index script runs
# through ts-node — `scripts/` is deliberately not in `tsconfig.build.json`.
# Including it is what once made TypeScript infer the repo root as `rootDir` and
# emit `dist/src/main.js`, silently breaking `node dist/main`.
ENV EMBEDDING_PROVIDER=precomputed
ENV DATABASE_PATH=/app/database/app.db
RUN pnpm corpus:index

# Drops dev dependencies from `node_modules` in place, so the runner can copy the
# tree as-is. A second `pnpm install --prod` would rebuild the native module and
# risk it differing from the one the index was just written with.
RUN pnpm prune --prod

# --- runner ------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

# 7860 is the Hugging Face Spaces default and harmless everywhere else; hosts
# that inject their own `PORT` (Render, Cloud Run, Northflank) override it.
ENV PORT=7860

# Connectors served from the bundled synthetic vault, which is what makes this a
# corpus-only surface. Note this is *not* `?demo=1` — the whole live pipeline
# runs, only the connector's documents are local.
ENV DEMO_MODE=true

# Off on a public instance, and deliberately (PLAN.md §9, §11). `recall()`
# searches all of `memory_facts` with no visitor filter, so cross-session — the
# M4.2 feature — is also cross-visitor where there is no sign-in. A session
# filter would delete what the milestone demonstrates, so the feature stays a
# local capability instead, like live connectors.
ENV LONG_TERM_MEMORY=false

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# `--chown` is load-bearing, not tidiness. The connection is opened read-write and
# `journal_mode = WAL` makes sqlite create `app.db-wal` and `app.db-shm` *beside*
# the file, so the directory has to be writable by the runtime user — not just the
# database. Root-owned, this image builds perfectly and then dies on first boot
# with SQLITE_READONLY_DIRECTORY, which is exactly the failure a green build hides.
COPY --from=builder --chown=node:node /app/database ./database
COPY --from=builder /app/package.json ./package.json

# `corpus/generated` is not optional at runtime, and leaving it out fails in the
# worst way: `ReindexScheduler` runs at boot, `removeDeletedArticles` finds every
# indexed path missing from disk, and the baked index is deleted by the first
# healthy startup. With the files present the same pass skips all 172 by checksum
# and costs nothing.
COPY --from=builder /app/corpus ./corpus
COPY fixtures ./fixtures

# Node's own unprivileged user, and `node_modules` is read-only to it — the
# process writes to `database/` and nowhere else.
USER node

EXPOSE 7860

# `dist/main`, not `dist/src/main` — see the note in the builder stage. This is
# the path `start:prod` uses and the one the emit layout was fixed to produce.
CMD ["node", "dist/main"]
