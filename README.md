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
- **A corpus that is an answer key.** 172 synthetic documents generated from a hand-authored
  fact ledger, plus 59 questions derived from fact ids (including 8 that should be refused
  and 3 whose supporting document tries to hijack the agent).
- **Observability.** Every run is traced twice: locally into sqlite (`runs` + `run_spans`,
  served by `GET /agent/runs/:runId`) and, when a key is configured, to LangSmith. Both show
  the same three-level hierarchy — node → tool → model call — and every run carries its token
  counts and an estimated cost.
- **Memory, with a forgetting policy.** Within a session, a LangGraph SQLite checkpointer
  keyed by `sessionId` lets a follow-up be a follow-up: *"who approved it?"* is rewritten into
  a standalone question before anything searches. Across sessions, durable facts about the
  person asking go through a funnel — proposed, scored, deduplicated, stored — and are decayed
  when nothing uses them. **The forgetting is the interesting part;** see below.

- **MCP connectors.** The same agent over data it does not own. An MCP client host connects
  to configured servers at boot, discovers their tools, and registers them into the existing
  registry — so a live Obsidian vault is searched by the same graph, through the same uniform
  tool interface, as the bundled corpus. **Adding it required no change to `src/agent/nodes/`;**
  see below.
- **A threat model, and the code that follows from it.** Once the system reads mail, the
  corpus is attacker-controlled. Retrieved text is fenced and labelled untrusted in every
  prompt, the tool surface is an operator-maintained allowlist, and no tool argument is ever
  derived from a document. The corpus carries real injection payloads to prove it.

Not yet built: the eval harness and CI gate (M6), which is where injection resistance stops
being asserted and starts being scored.

## Architecture

```
POST /agent/ask  (SSE)  ->  LangGraph StateGraph  ->  Tool registry  ->  RetrievalService
                            triage -> plan ->          mail_search      -> sqlite-vec KNN
                            execute -> reflect ->      chat_search
                            synthesize                 notes_search
                                                       all_sources_search
                                                       obsidian_search_notes
                                                            |
                                                            v
                                                       MCP client host -> MCP server
                                                       (stdio, or in-process in DEMO_MODE)
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
│   ├── checkpointing/ # LangGraph SQLite saver — short-term (within-session) memory
│   ├── replay/     # recorded runs replayed over SSE (the ?demo=1 path)
│   └── examples/   # corpus/questions.yaml projected for the UI's one-click examples
├── integrations/   # MCP client host: connects to servers, discovers tools, adapts results
│   └── mcp/demo/   # the synthetic MCP server DEMO_MODE serves, over an in-memory transport
├── memory/         # long-term memory: the extract→score→dedup→store funnel, and its stats
├── observability/  # LangSmith bridge, span collection, token/cost accounting
└── scheduler/      # background reindex + memory consolidation jobs

ui/                 # Next.js App Router UI — pure rendering over the SSE event contract
corpus/             # ledger (hand-authored ground truth) + generated documents + questions
fixtures/runs/      # captured agent runs, committed; written by `pnpm capture:runs`
fixtures/mcp/vault/ # the synthetic Obsidian vault DEMO_MODE's connector searches
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
| `/memory/stats`           | GET    | The long-term memory retention funnel, and how many facts survive |
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

## Memory

Two kinds, and the second one is mostly about what it refuses to keep.

### Within a session — short-term

A LangGraph checkpointer with a SQLite saver, keyed by `sessionId`. `POST /agent/ask` mints a
session when the caller sends none and reports it on `run_started`; send it back and the next
question is treated as a follow-up.

Before anything else runs, a `recall` node rewrites the question so it stands on its own:

```
turn 1  "Why did the Helios launch slip?"
turn 2  "Who approved it?"              → "Who approved the Helios launch slip?"
turn 3  "What was her role when she joined?"
                                        → "What was Priya Raman's role when she joined?"
```

Turn 3 is the interesting one: *her* was resolved out of turn 2's **answer**, not its
question. The rewrite is announced as a `followup_resolved` event, so the UI can show what
was asked next to what was searched for — an agent quietly reinterpreting a question should
not be invisible.

Sessions are bounded by `CHECKPOINT_RETENTION_SESSIONS` (50). A checkpoint is written per
graph superstep and carries the whole state, so a three-turn conversation costs ~230KB — this
store grows several times faster than the trace store does.

### Across sessions — long-term, and the funnel

After a run answers, a `fast`-tier call proposes durable facts about the person asking. Each
one then has to survive three gates:

| Stage | What it does | Counter |
| --- | --- | --- |
| **Extraction** | proposes candidates: preferences, relationships, corrections | `proposed` |
| **Scoring** | anything under `MEMORY_IMPORTANCE_FLOOR` (0.5) is dropped — before it costs an embedding call | `droppedLowImportance` |
| **Deduplication** | embed, find the nearest stored fact; within `MEMORY_DEDUP_DISTANCE` it *merges* — bumping a counter on the fact it restates | `mergedDuplicate` |
| **Storage** | what is left | `stored` |

`GET /memory/stats` returns those four counters and `stored / proposed`. That ratio is the
honest measure of a memory system: **"it stores roughly N% of what it could" is checkable;
"it has memory" is not.** The counters are cumulative and survive restarts, so the number
means something after a few hundred runs rather than a few.

A consolidation job (`MEMORY_CONSOLIDATION_INTERVAL_MS`) then does what write-time dedup
cannot: it re-compares every surviving fact against every other, merging pairs that have
drifted together, and forgets anything no question has needed in `MEMORY_TTL_DAYS`. Decay is
measured from when a fact was last *retrieved into a run*, not when it was last written — a
fact nobody's questions ever touch is precisely the one worth forgetting.

Before `triage`, the closest `MEMORY_TOP_K` facts are put in front of the run. They reach the
planner and the synthesiser as *background*, never as passages: only retrieved chunks carry
citation numbers, so a remembered fact cannot become `[3]` — and if a model tried,
`resolveCitations` would find the marker out of range and strip it. That guarantee is
mechanical rather than a matter of the model complying.

Observed end to end: *"I work on the Helios billing migration. Why did the launch slip?"* in
one session, then — in a **new** session with no shared history — *"Did it ship on time in the
end?"*, answered about Helios, because that was what memory supplied. Restating the same fact
in a third session merged rather than duplicated: one row, `access_count` 2.

`MEMORY_DEDUP_DISTANCE` was measured, not guessed — restatements of one fact land at
0.087–0.276 under `gemini-embedding-001` at 768d while genuinely distinct facts start at
0.405, and 0.35 takes the empty band between them. **The number is specific to that embedding
model**; see [`docs/memory-dedup-threshold.md`](docs/memory-dedup-threshold.md) for the
measurement and how to redo it.

## Connectors

The claim M1 made was that tools are uniform — `{name, description, inputSchema, execute}` —
and that whether one hits the local index or a live MCP server is invisible to the graph. M5
is the test of that claim, and it held: **adding MCP connectors changed no file under
`src/agent/nodes/`.** Two files there did change in the same milestone — `reflect.node.ts` and
`synthesize.node.ts` each gained the untrusted-content fence described under
[Security](#security-retrieved-content-is-attacker-controlled) — but that is prompt hardening,
not connector plumbing, and the connector works identically without it. Everything the
connector itself needed lives outside `src/agent/nodes/` entirely.

What it took instead:

- `src/integrations/mcp/mcp-host.service.ts` connects to each configured server, asks it what
  tools it has, and wraps the permitted ones as `AgentTool`s.
- `agent.module.ts`'s `AGENT_TOOLS` factory became `async`, because discovery is a network
  call and `ToolRegistry` builds its map in its constructor. That is the single structural
  change on the agent side.
- The planner reads `describeForPlanner()` at prompt-build time, so a connector appears in
  the tool menu with no prompt edit. In the run below the planner chose `obsidian_search_notes`
  over `notes_search` on its own, from the description alone.

### Demo mode is a real connector, not a stub

`DEMO_MODE=true` (the default) serves a **real MCP server** running in-process over the SDK's
in-memory transport, reached through the same `Client` a live server would be. Only the
transport and the data differ. Discovery, query-argument resolution, argument validation and
result adaptation are all exercised by the deployed demo rather than bypassed by it — a fake
object implementing `AgentTool` would have been a tenth of the code and would have proved
nothing.

It is **not** the same thing as `?demo=1`, which replays a recorded run and makes no model
calls at all. `DEMO_MODE` runs the entire live pipeline and only changes where a connector's
documents come from. It removes the need for *connector* credentials — a Gmail grant, a Slack
token, a vault on disk — not the need for an LLM key.

To connect a real one, set `DEMO_MODE=false` and:

```jsonc
MCP_SERVERS=[{
  "name": "obsidian",              // tool prefix and evidenceId namespace
  "command": "npx",
  "args": ["-y", "obsidian-mcp", "/path/to/vault"],
  "source": "notes",               // which corpus source its results are filed as
  "allowTools": ["search_notes"]   // REQUIRED — see below
}]
```

Observed live, against the demo connector — *"What did Priya privately conclude about why the
Helios launch slipped, and what did she decide to do differently?"*: triage `complex` → two
sub-questions, both assigned to `obsidian_search_notes` → 5 passages → `gapFound: false` →
a four-citation answer in which every marker resolves to a vault note. 3.9k input tokens.

### Two things that were not free

**Evidence identity.** `evidenceId` was minted from a numeric `chunkId` — a sqlite rowid.
MCP results have no rowid, and a connector returning `1` for its first result would have
produced `ev-1`, which is already corpus chunk 1. `mergeEvidence` dedupes by `evidenceId`, so
one of the two would have been dropped in silence and a citation would then have resolved to
the wrong passage: a wrong answer, not an error. External sources now mint a namespaced id
(`ev-obsidian:Projects/Helios.md`), which cannot collide because a corpus id is always an
integer.

**Relevance is calibrated, not measured.** `synthesize` ranks all evidence on `distance`
alone, so a connector's passages compete directly with the vector index on a scale they have
no way to measure. Connector results are mapped into the band the corpus actually occupies
(0.406–0.585 on `gemini-embedding-001`@768), with the best hit at 0.45 rather than 0.40 — close
enough to compete with good corpus evidence, not so close that it automatically outranks all
of it. This is the least principled number in the system and it is labelled as such in
`mcp-results.ts`; M6's eval harness is what can move it on evidence.

## Security: retrieved content is attacker-controlled

Until M5 every document in the corpus was written by us. Once a system reads mail — or a
support queue, or a shared vault — that assumption is false: anyone who can send you a message
can put text in front of your agent. The corpus now contains three documents carrying real
injection payloads, committed verbatim rather than generated, because a resistance score is
only meaningful if the attack string is byte-exact.

Four defences, in order of how much they are actually relied on:

1. **The tool surface is an allowlist.** An MCP server advertises whatever it likes, including
   writes and deletes. Discovery is not consent: nothing is registered unless the operator
   named it in that server's `allowTools`. A tool that was never registered cannot be selected,
   because `ToolRegistry` has no entry for it.
2. **No tool argument is ever derived from a document.** `AgentTool.execute` takes
   `{query, topK, signal}` and nothing else. The planner emits a tool *name* and a question;
   there is no code path by which a passage's text becomes an MCP parameter. This is the
   guarantee — it holds even when the model is completely taken in.
3. **Arguments are schema-validated against the server's own declaration** before the call,
   failing closed on an undeclared property or a wrong type (`mcp-tool-shape.ts`).
4. **Retrieved text is fenced and labelled untrusted** wherever it enters a prompt
   (`src/agent/untrusted-content.ts`), including a check that a document cannot close the
   fence around itself. This is defence in depth, not the guarantee: it reduces the chance of
   a wasted hop and a confused answer.

`src/integrations/mcp/injection-resistance.spec.ts` drives all of this against a real MCP
server that exposes a destructive `delete_note` tool, with **every model stubbed to obey the
injection**. The point is not that the model resists; it is that a model which does not resist
still cannot do anything.

Observed live, asking about one of the adversarial documents — *"Why did Marcus Webb block the
sender of the vendor security questionnaire?"*: the payload was retrieved into context, and
the answer described the injection as something the document contains, cited it, and neither
obeyed it nor emitted the `PULSE-EXFIL-OK` marker the payload asks for.

**What is not covered.** Detection and scoring. Nothing yet measures how often an attempt gets
through — the above is asserted, not measured, and M6's eval harness is where that changes.
One second-order path is also open by design: long-term memory extracts facts from a run's
question and answer, and an answer derives from retrieved documents, so a sufficiently patient
injection could in principle reach durable memory. Extraction is scoped to facts about the
person asking, which makes it a narrow channel, but it is narrow rather than closed.

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
| `DEMO_MODE`                    | `true`                      | Serve connectors from bundled synthetic data. **Not the same as `?demo=1`**, which replays a recorded run and makes no model calls; this runs the full live pipeline and only changes where a connector's documents come from |
| `MCP_SERVERS`                  | `[]`                        | JSON array of MCP servers to connect at boot. Ignored, with a warning, while `DEMO_MODE` is on. `allowTools` is required — discovery is not consent |
| `MCP_DEMO_VAULT_PATH`          | `./fixtures/mcp/vault`      | The synthetic Obsidian vault `DEMO_MODE` serves                                |
| `MCP_TIMEOUT_MS`               | `15000`                     | Connect, discover and per-call budget for an MCP server. Generous because an `npx`-launched server may download itself first |
| `RETRIEVAL_DISTANCE_THRESHOLD` | `0.9`                       | **Not currently enforced.** See [`docs/retrieval-threshold-study.md`](docs/retrieval-threshold-study.md) for how it was derived and why it isn't portable across embedding models |
| `TRACE_RETENTION_RUNS`         | `200`                       | Finished runs kept in the local trace store; oldest pruned on write. No unlimited option — see [`env.schema.ts`](src/config/env.schema.ts) |
| `CHECKPOINT_RETENTION_SESSIONS` | `50`                       | Sessions kept by the short-term-memory checkpointer; oldest pruned after every run          |
| `MEMORY_IMPORTANCE_FLOOR`      | `0.5`                       | Candidate facts below this are dropped before they cost an embedding call                   |
| `MEMORY_DEDUP_DISTANCE`        | `0.35`                      | L2 distance at or below which a candidate merges into the fact it restates. **Model-specific** — see [`docs/memory-dedup-threshold.md`](docs/memory-dedup-threshold.md) |
| `MEMORY_TOP_K`                 | `3`                         | Remembered facts injected into a run's context                                              |
| `MEMORY_RECALL_DISTANCE`       | `0.49`                      | L2 ceiling for recalling a fact into a run. Without it a small store returned everything to every question, and decay could never fire. **Model-specific**, from the same measurement as `MEMORY_DEDUP_DISTANCE` but on thinner evidence |
| `MEMORY_TTL_DAYS`              | `30`                        | Forget a fact no run has retrieved in this long                                             |
| `MEMORY_CONSOLIDATION_INTERVAL_MS` | `21600000`              | How often near-duplicates are merged and stale facts forgotten (6h)                         |
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

The setting is "Lumen Labs", a fictional company: 16 people, 6 projects, 172 documents
across 9 storylines, roughly 100 of them pure noise. No real data is involved.

## Migration path to Postgres + pgvector

Deliberately out of scope — see `PLAN.md` §2 (Anti-goals) for why. If ever needed:
implement `Postgres*Repository` classes for each port in `src/repositories/ports/`, bind them
in `repositories.module.ts`, and swap the `vec0` KNN query for a pgvector `<->` query. No
other code changes required — every consumer depends on the port interfaces, not SQLite.

## License

MIT
