# throughline

An agentic RAG system that answers questions whose evidence is scattered across multiple
sources — email, chat, notes — by planning a multi-step retrieval strategy, gathering
evidence from several sources, and producing one cited answer.

**Status: early / in progress.** This repo started as a single-source RAG pipeline (Markdown
knowledge base → chunk → embed → retrieve → generate) and is being rebuilt into a
multi-source planning agent. See [`PLAN.md`](PLAN.md) for the full roadmap, current
milestone, and design rationale — that document is the source of truth on where this project
is headed and why.

## What works today

The retrieval foundation, inherited from the original pipeline and being extended:

- Markdown knowledge base → chunked → embedded (Ollama) → indexed in SQLite (`sqlite-vec`).
- A repository-ports architecture (`src/repositories/ports/*`) so the storage backend is
  swappable without touching business logic.
- An idempotent, checksum-based reindexing pipeline that skips unchanged files and cleans up
  deleted ones (`src/knowledge/indexing.service.ts`).
- Zod-validated environment configuration (`src/config/env.schema.ts`).

Not yet built: the agent/planner, multi-source tools, memory, tracing, and the UI. Those are
`PLAN.md` milestones M1–M6.

## Architecture (current)

```
POST /knowledge/reindex
  knowledge/articles/*.md → chunk → embed (Ollama) → SQLite (chunks + sqlite-vec embeddings)

GET /knowledge/search?q=&k=
  query → embed → sqlite-vec k-NN → top-K chunks with distance scores
```

### Repository pattern

Business logic never talks to SQLite directly. `src/repositories/ports/*.ts` define
interfaces (`ArticleRepository`, `ChunkRepository`, `EmbeddingRepository`,
`IndexStateRepository`); `src/repositories/sqlite/*.ts` implement them;
`repositories.module.ts` is the single place that binds interface → implementation via
NestJS DI tokens. New storage backends (or new embedding/LLM providers, per `PLAN.md` M1)
plug in behind these ports without touching callers.

### Folder structure

```
src/
├── config/        # Zod-validated env vars, typed AppConfigService
├── logger/        # Pino structured logging
├── database/       # better-sqlite3 connection, sqlite-vec extension, migrations
├── repositories/    # ports (interfaces) + sqlite (implementations)
├── knowledge/       # markdown loading, chunking, indexing pipeline
├── embeddings/      # Ollama embeddings client
├── ai/
│   └── llm/         # Ollama chat client
├── rag/             # vector retrieval service + debug search endpoint
└── scheduler/       # background reindex job

knowledge/articles/  # markdown knowledge base (source of truth)
prompts/             # LLM prompts, kept external to code
database/app.db       # SQLite file (gitignored)
```

## Prerequisites

- Node.js 22+, pnpm 10+
- [Ollama](https://ollama.com) running locally, with models pulled:
  `ollama pull qwen3.5:9b && ollama pull bge-m3`

## Setup

```bash
cp .env.example .env      # defaults work for local dev, no secrets in it
pnpm install
pnpm start:dev             # http://localhost:5000
curl -X POST http://localhost:5000/knowledge/reindex
```

## API

| Route                     | Method | Purpose                                              |
| ------------------------- | ------ | ----------------------------------------------------- |
| `/health`                 | GET    | Liveness check                                         |
| `/knowledge/reindex`      | POST   | Re-chunk/re-embed changed knowledge files              |
| `/knowledge/search?q=&k=` | GET    | Debug: raw RAG retrieval for a query                   |

## Environment variables

| Var                            | Default                  | Purpose                                                                       |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| `PORT`                         | `5000`                    | HTTP port                                                                      |
| `OLLAMA_URL`                   | `http://localhost:11434`  | Ollama API base URL                                                            |
| `CHAT_MODEL`                   | `qwen3.5:9b`              | Chat model                                                                     |
| `EMBEDDING_MODEL`              | `bge-m3`                  | Embedding model                                                                |
| `EMBEDDING_DIMENSIONS`         | `1024`                    | Must match the embedding model's output size (delete `database/app.db` when changing) |
| `DATABASE_PATH`                | `./database/app.db`       | SQLite file path                                                               |
| `KNOWLEDGE_PATH`               | `./knowledge/articles`    | Markdown knowledge base directory                                              |
| `PROMPTS_PATH`                 | `./prompts`               | Prompt files directory                                                        |
| `REINDEX_INTERVAL_MS`          | `1800000`                 | Background reindex interval                                                    |
| `TOP_K`                        | `5`                       | Chunks retrieved per query                                                     |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `700` / `150`             | Chunking window (words)                                                       |
| `RETRIEVAL_DISTANCE_THRESHOLD` | `0.9`                     | See [`docs/retrieval-threshold-study.md`](docs/retrieval-threshold-study.md) for how this was derived and why it isn't portable across embedding models |

## Migration path to Postgres + pgvector

Deliberately out of scope for now — see `PLAN.md` §2 (Anti-goals) for why. If ever needed:
implement `Postgres*Repository` classes for each port in `src/repositories/ports/`, bind them
in `repositories.module.ts`, and swap the `vec0` KNN query for a pgvector `<->` query in the
Postgres equivalent. No other code changes required — every consumer depends on the port
interfaces, not SQLite directly.

## License

MIT
