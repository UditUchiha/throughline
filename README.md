# throughline

An agentic RAG system that answers questions whose evidence is scattered across multiple
sources — email, chat, notes — by planning a multi-step retrieval strategy, gathering
evidence from several sources, and producing one cited answer.

**Status: M0–M2 done.** The agent graph runs, streams its reasoning over SSE, and a UI
renders that stream live. See [`PLAN.md`](PLAN.md) for the roadmap and design rationale —
that document is the source of truth on where this project is headed and why, and
[`HANDOFF.md`](HANDOFF.md) is the orientation doc if you are picking this up cold.

## What works today

- **The agent graph.** LangGraph `StateGraph`: triage → (plan) → execute → reflect ↺ →
  synthesize. Triage decides whether a question needs decomposing at all; a `simple` one
  skips planning and answers in ~4s instead of ~10s.
- **Multi-source retrieval.** `mail_search` / `chat_search` / `notes_search` /
  `all_sources_search`, fanned out in parallel.
- **Reflection.** After retrieval the agent judges whether a gap remains and issues a
  second hop if so.
- **Citations that resolve.** Every retrieved chunk gets a stable `evidenceId` when it
  enters agent state, and citations reference that id — so citation validity is a
  deterministic check, not an LLM judgment.
- **Streaming.** A frozen event contract (`src/agent/events.ts`) over SSE, and a Next.js UI
  that renders the plan, the parallel tool timeline, the evidence and the cited answer as
  they arrive.
- **Recorded-run replay.** `?demo=1` replays a captured run over the same event stream with
  zero model calls — the demo still works when a free tier is exhausted.
- **A corpus that is an answer key.** 169 synthetic documents generated from a hand-authored
  fact ledger, plus 56 questions derived from fact ids (including 8 that should be refused).
- **Observability.** Every run is traced twice: locally into sqlite (`runs` + `run_spans`,
  served by `GET /agent/runs/:runId`) and, when a key is configured, to LangSmith. Both show
  the same three-level hierarchy — node → tool → model call — and every run carries its token
  counts and an estimated cost.

Not yet built: memory (M4), MCP connectors (M5), and the eval harness and CI gate (M6).

## Architecture

```
POST /agent/ask  (SSE)  ->  LangGraph StateGraph  ->  Tool registry  ->  RetrievalService
                            triage -> plan ->          mail_search      -> sqlite-vec KNN
                            execute -> reflect ->      chat_search
                            synthesize                 notes_search
                                                       all_sources_search
                                    |
                                    v
                          LLM: one OpenAI-compatible client with a configurable baseURL
                          (gemini | groq | openrouter | ollama), with a failover chain
```

Gemini, Groq, OpenRouter and Ollama all speak OpenAI-compatible `/v1`, so there is **one**
provider class parameterised by `baseURL` rather than a class per vendor plus a router.
Calling code asks for a logical tier (`fast` / `default` / `deep`), never a model id.

### Repository pattern

Business logic never talks to SQLite directly. `src/repositories/ports/*.ts` define
interfaces (`ArticleRepository`, `ChunkRepository`, `EmbeddingRepository`,
`IndexStateRepository`); `src/repositories/sqlite/*.ts` implement them;
`repositories.module.ts` is the single place that binds interface → implementation via
NestJS DI tokens.

### Folder structure

```
src/
├── config/         # Zod-validated env vars, typed AppConfigService — the only place env is read
├── logger/         # Pino structured logging
├── database/       # better-sqlite3 connection, sqlite-vec, migrations, index-identity check
├── repositories/   # ports (interfaces) + sqlite (implementations)
├── knowledge/      # markdown loading, chunking, idempotent indexing
├── embeddings/     # embedding providers (gemini, ollama) behind EMBEDDING_SERVICE
├── ai/llm/         # one OpenAI-compatible client, tier→model map, failover chain
├── rag/            # vector retrieval service + debug search endpoint
├── agent/          # the graph: state, nodes, tools, frozen event contract, SSE controller
│   ├── replay/     # recorded runs replayed over SSE (the ?demo=1 path)
│   └── examples/   # corpus/questions.yaml projected for the UI's one-click examples
└── scheduler/      # background reindex job

ui/                 # Next.js App Router UI — pure rendering over the SSE event contract
corpus/             # ledger (hand-authored ground truth) + generated documents + questions
fixtures/runs/      # captured agent runs, committed; written by `pnpm capture:runs`
evals/              # eval harness — empty until M6
scripts/            # authoring tools, run outside the Nest context
database/app.db     # SQLite file (gitignored)
```

## Prerequisites

- Node.js 22+, pnpm 10+
- An API key for the chat and embedding provider. The default is Gemini
  (`gemini-3.5-flash-lite` for chat, `gemini-embedding-001` at 768d for embeddings), and a
  Groq key as a fallback is strongly recommended — free-tier quota is the dominant failure
  mode without one.
- [Ollama](https://ollama.com) only if you set `LLM_PROVIDER=ollama` or
  `EMBEDDING_PROVIDER=ollama`.

## Setup

```bash
pnpm install
cp .env.example .env      # then fill LLM_API_KEY (and ideally GROQ_API_KEY +
                          # LLM_FALLBACK_PROVIDERS=groq)
pnpm start:dev            # API on http://localhost:5000
```

Ask it something:

```bash
curl -N -X POST localhost:5000/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"Why did the Helios launch slip, and who approved the new date?"}'
```

Or replay a recorded run instead, which calls no models at all:

```bash
curl localhost:5000/agent/demo   # what is available
curl -N -X POST 'localhost:5000/agent/ask?demo=1' \
  -H 'Content-Type: application/json' \
  -d '{"question":"What did the board approve and what were the outcomes?"}'
```

### The UI

```bash
cd ui
pnpm install
cp .env.example .env.local    # NEXT_PUBLIC_API_URL, defaults to localhost:5000
pnpm dev                      # http://localhost:3000
```

Open <http://localhost:3000/?demo=1> to browse the recorded runs without spending any
quota. The UI and the API deploy separately (Vercel / Hugging Face Spaces), so the browser
always makes a cross-origin request; the API enables CORS for any origin because there is
no sign-in and no credentials involved.

## API

| Route                     | Method | Purpose                                                          |
| ------------------------- | ------ | ---------------------------------------------------------------- |
| `/health`                 | GET    | Liveness check                                                    |
| `/agent/ask`              | POST   | Run the agent, streaming its events as SSE. `?demo=1` replays a recording |
| `/agent/runs/:runId`      | GET    | A finished run — metadata, its full event stream, and its span tree |
| `/agent/demo`             | GET    | The recorded runs available for replay                            |
| `/agent/examples`         | GET    | The authored question set, as one-click examples for the UI       |
| `/knowledge/reindex`      | POST   | Re-chunk/re-embed changed corpus files                            |
| `/knowledge/search?q=&k=` | GET    | Debug: raw RAG retrieval for a query                              |

`/agent/examples` serves only each question's text, category, required sources and hop
count. `referenceAnswer` and `requiredFacts` are the answer key and never leave the server.

## Observability

Every run is inspectable two ways, and both show the same shape.

**Locally, always on.** A run is written to sqlite as one `runs` row plus a tree of
`run_spans`, and `GET /agent/runs/:runId` returns the lot: the metadata, the exact event
stream it emitted (so the run stays replayable), and the spans. Spans come in four kinds —
the run itself, each graph node, each retrieval call, and each model call — so a trace shows
where the time actually went. It usually went to the model: a 26s run routinely finishes all
of its retrieval inside 4s.

Failed runs are stored too. That is deliberate, and it is the main thing this replaced: the
in-memory store used until M3 was capped at 100 runs, emptied on every restart, and only ever
saw runs that returned — so the runs most worth reading were exactly the ones it dropped.

```bash
curl -s localhost:5000/agent/runs/<runId> | jq '.spans[] | {kind, name, durationMs}'
```

**LangSmith, opt-in.** Set `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY` (the free
personal tier is enough), and **set `LANGSMITH_ENDPOINT` to your account's region** — a key
issued in one region is refused by every other region's endpoint with a bare `403 Forbidden`
on all authenticated calls, which is indistinguishable from a bad key. US is the default;
EU is `https://eu.api.smith.langchain.com` and APAC is `https://apac.api.smith.langchain.com`.

The hierarchy has three levels, and only the top one comes for free:

- LangGraph reports its own nodes as soon as the environment is set.
- Model calls go through the raw `openai` SDK rather than a LangChain chat model, so they
  are **not** traced by that alone. `LangSmithTracing.wrapClient` wraps each provider's
  client so a call nests under the node that made it. Without it a trace stops at the node
  and the model level is simply missing.
- Retrieval tools are plain functions, so they are invisible to LangGraph too.
  `LangSmithTracing.traceTool` wraps each call as a `retriever` run, which is what puts the
  *tool* level between the node and the model call.

Verified 2026-09-05 — this is a real run, exactly as LangSmith renders it:

```
LangGraph 13.4s
├─ triage      996ms   → [llm] ChatOpenAI
├─ plan       1351ms   → [llm] ChatOpenAI
├─ execute     914ms   → [retriever] chat_search   620ms
│                      → [retriever] notes_search  907ms
├─ reflect    1445ms   → [llm] ChatOpenAI              gap found
├─ execute     864ms   → [retriever] notes_search  846ms
│                      → [retriever] mail_search   860ms
├─ reflect    1370ms   → [llm] ChatOpenAI              no gap
└─ synthesize 6467ms   → [llm] ChatOpenAI
```

**[→ Open a real trace in LangSmith](https://apac.smith.langchain.com/public/14204394-ae03-4e47-afb0-8ada1c2dd735/r/01a06fe7-641a-700e-8d18-34e5efc77473)**
(public, no account needed)

That link is the run diagrammed above: 13.4s end to end, two citations. It is worth opening
rather than taking on trust, because it shows the thing this project is actually about —
`execute` appears **twice**. The first pass fans out across chat and notes, `reflect` decides
the evidence has a gap, and a second pass goes back out to notes and mail before
`synthesize` runs. That second hop is the agentic part; single-shot RAG has no equivalent.

**Cost.** Token counts come from the provider's own usage numbers, and cost is estimated per
call from the table in [`src/config/model-prices.ts`](src/config/model-prices.ts) — priced per
call rather than per run because failover can change vendor mid-run. Ollama is $0. A model
with no entry in that table makes the whole run's cost `null` ("not priced" in the UI) rather
than understating it; adding the model to the table is all it takes to price it.

Prices were verified against each provider's pricing page on 2026-09-05 and are standard
synchronous rates — batch and cached-input discounts are not modelled, because this agent
uses neither. Treat the figure as an estimate: it is labelled one, and a stale price is the
quietest kind of wrong.

**Retention.** The trace store keeps `TRACE_RETENTION_RUNS` runs (200 by default) and prunes
oldest-first on write.

## Environment variables

| Var                            | Default                     | Purpose                                                                       |
| ------------------------------ | --------------------------- | ----------------------------------------------------------------------------- |
| `PORT`                         | `5000`                      | HTTP port                                                                      |
| `LLM_PROVIDER`                 | `gemini`                    | `gemini` \| `groq` \| `openrouter` \| `ollama`                                 |
| `LLM_API_KEY`                  | —                           | Key for the primary provider                                                   |
| `LLM_FALLBACK_PROVIDERS`       | —                           | Ordered chain tried on quota/5xx, e.g. `groq`                                  |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` | —  | Per-provider keys, so a chain can authenticate to each hop                     |
| `LLM_MODEL_FAST` / `_DEFAULT` / `_DEEP` | —                  | Override the tier→model map for the primary provider                           |
| `LLM_MAX_RETRIES`              | `2`                         | Deliberately low — retrying into a quota 429 exhausts the window faster        |
| `EMBEDDING_PROVIDER`           | `gemini`                    | `gemini` \| `ollama`                                                           |
| `EMBEDDING_MODEL`              | `gemini-embedding-001`      | Embedding model. The bare Zod fallback is `bge-m3`, which only pairs with `EMBEDDING_PROVIDER=ollama` — copy `.env.example` rather than relying on it |
| `EMBEDDING_DIMENSIONS`         | `768`                       | Must match the model's output size (`1024` for `bge-m3`). Delete `database/app.db` when changing |
| `OLLAMA_URL`                   | `http://localhost:11434`    | Ollama API base URL                                                            |
| `CHAT_MODEL`                   | `qwen3.5:9b`                | Chat model, when `LLM_PROVIDER=ollama`                                         |
| `DATABASE_PATH`                | `./database/app.db`         | SQLite file path                                                               |
| `KNOWLEDGE_PATH`               | `./corpus/generated`        | Markdown corpus directory                                                      |
| `PROMPTS_PATH`                 | `./prompts`                 | Prompt files directory                                                         |
| `DEMO_RUNS_PATH`               | `./fixtures/runs`           | Recorded runs replayed by `?demo=1`                                            |
| `CORPUS_QUESTIONS_PATH`        | `./corpus/questions.yaml`   | Question set served by `/agent/examples`                                       |
| `REINDEX_INTERVAL_MS`          | `1800000`                   | Background reindex interval                                                    |
| `TOP_K`                        | `5`                         | Chunks retrieved per query                                                     |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `700` / `150`               | Chunking window, counted in **words**                                          |
| `MAX_HOPS` / `MAX_FAN_OUT`     | `2` / `5`                   | Reflect-loop and per-hop parallelism budgets                                   |
| `AGENT_TIMEOUT_MS`             | `60000`                     | Wall-clock budget for one run                                                  |
| `RETRIEVAL_DISTANCE_THRESHOLD` | `0.9`                       | **Not currently enforced.** See [`docs/retrieval-threshold-study.md`](docs/retrieval-threshold-study.md) for how it was derived and why it isn't portable across embedding models |
| `TRACE_RETENTION_RUNS`         | `200`                       | Finished runs kept in the local trace store; oldest pruned on write. No unlimited option — see [`env.schema.ts`](src/config/env.schema.ts) |
| `LANGSMITH_TRACING`            | `false`                     | Send traces to LangSmith. Enabling it without `LANGSMITH_API_KEY` fails at boot, because LangSmith drops traces silently when it cannot authenticate |
| `LANGSMITH_API_KEY`            | —                           | LangSmith key. The free personal tier is enough                                |
| `LANGSMITH_PROJECT`            | `throughline`               | Project traces are filed under                                                 |
| `LANGSMITH_ENDPOINT`           | `https://api.smith.langchain.com` | **Must match the region your account was created in**, or every authenticated call 403s and it looks exactly like a bad key. US is the default; EU `https://eu.api.smith.langchain.com`, APAC `https://apac.api.smith.langchain.com`. Also the override for self-hosted |

## Scripts

| Task                                | Command                                    |
| ----------------------------------- | ------------------------------------------ |
| Build / lint / test                 | `pnpm build` · `pnpm lint` · `pnpm test`   |
| Re-verify the corpus answer key     | `pnpm corpus:generate --verify-only`       |
| Regenerate docs for one fact        | `pnpm corpus:generate --only=fact.<id>`    |
| Re-record the demo fixtures         | `pnpm capture:runs` (server must be running) |
| UI lint / type-check / tests        | `cd ui && pnpm lint && pnpm typecheck && pnpm test` |

## The corpus is an answer key, not test data

`corpus/ledger/{entities,facts,documents}.yaml` is hand-authored ground truth;
`corpus/generated/**` is LLM-written prose expressing it; `corpus/questions.yaml` derives
questions from fact ids. Facts are authored **first** — never write a question by reading a
generated document. That ordering is what keeps the eval suite from grading the model
against its own output.

The setting is "Lumen Labs", a fictional company: 16 people, 6 projects, 169 documents
across 9 storylines, roughly 100 of them pure noise. No real data is involved.

## Migration path to Postgres + pgvector

Deliberately out of scope — see `PLAN.md` §2 (Anti-goals) for why. If ever needed:
implement `Postgres*Repository` classes for each port in `src/repositories/ports/`, bind them
in `repositories.module.ts`, and swap the `vec0` KNN query for a pgvector `<->` query. No
other code changes required — every consumer depends on the port interfaces, not SQLite.

## License

MIT
