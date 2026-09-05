# HANDOFF — throughline

Orientation document for a new agent or contributor picking this project up cold.
**It is a map, not a spec.** `PLAN.md` is the source of truth for scope, sequencing and
acceptance criteria; `CLAUDE.md` is the always-loaded rules digest. This file tells you
where you are, what has actually been proven, and what to do next.

_Last updated: 2026-09-05 (M3 built — runs are traced, stored and costed; M4 is next)._

---

## 1. The idea in one paragraph

**throughline** is an agentic RAG system over scattered work data — email, chat, notes. A
visitor asks a question whose answer lives in no single document. The system triages it,
decomposes it into sub-questions, fans out across source-specific retrieval tools in
parallel, reflects on whether a gap remains (and issues a second hop if so), then synthesizes
one answer where every claim carries a citation that resolves back to a specific retrieved
chunk. The whole run streams live over SSE so the UI can render the reasoning as it happens.

It is a portfolio project converted from client work. The bar is: _a stranger clones it, runs
it, and understands it in ten minutes_ — and every milestone boundary leaves something
demoable. Feature count is not the goal.

**The differentiator is the graph, not the RAG.** Single-source single-hop retrieval is
plumbing. Questions that require joining evidence across mail + chat + notes, and an agent
that knows when _not_ to decompose, are the point.

## 2. The demo that has to work

Deployed URL → type a question → watch the system (1) decide it needs decomposition and show
the sub-questions, (2) fan out to multiple tools in parallel with visible latencies, (3) show
retrieved evidence with scores and source attribution, (4) notice a gap and issue a follow-up
retrieval, (5) produce a cited answer, (6) show what it remembered. No sign-in, no visitor API
key, pre-seeded data, under 30 seconds.

**If a change does not move toward that demo, it is not in scope for M0–M4.** (PLAN.md §1.)

---

## 3. How it is built

### Stack

NestJS 11 (DI everywhere) · TypeScript · better-sqlite3 + `sqlite-vec` for vector KNN ·
Zod-validated env · Pino logging · `openai` SDK used as a _generic OpenAI-compatible client_ ·
LangGraph.js for orchestration · Next.js 16 (App Router) + Tailwind v4 in `ui/`, deployed
separately to Vercel · Node 22, pnpm.

### Architectural spine

```
HTTP (SSE)  ->  LangGraph StateGraph  ->  Tool Registry  ->  RetrievalService
                triage -> plan ->          mail_search       -> EmbeddingRepository (sqlite-vec)
                execute -> reflect ->      chat_search
                synthesize                 notes_search
                                           all_sources_search
                        |
                        v
              LLM: one OpenAI-compatible client, configurable baseURL
              (gemini | groq | openrouter | ollama)
```

### The four design commitments that explain most of the code

1. **The graph is the product.** Everything else is support.
2. **Tools are uniform** — `{name, description, inputSchema, execute}`. Whether a tool hits
   the local index (M1–M4) or a live MCP server (M5) is invisible to the graph. This is what
   makes M5 additive instead of a rewrite.
3. **Every retrieved chunk gets a stable `evidenceId` the moment it enters agent state.**
   Citations reference `evidenceId`, never free text — so citation validity is a
   _deterministic_ assertion, not an LLM judgment. This is load-bearing for M6's eval gate.
4. **Streaming is not an afterthought.** The event contract is frozen in M1 _before_ the UI
   exists, so M2 is pure rendering.

### One provider abstraction, not four

Gemini, Groq, OpenRouter and Ollama all expose OpenAI-compatible `/v1` endpoints. There is
**one** `OpenAICompatibleProvider` with a configurable `baseURL` and a provider-to-model map,
not a class per vendor plus a router. Calling code asks for a logical tier (`fast` /
`default` / `deep`), never a model ID. Anthropic would need its own client — the seam is
marked with a `TODO(anthropic)` at the provider switch, deliberately unimplemented.

### The corpus is an answer key, not test data

`corpus/ledger/{entities,facts,documents}.yaml` is **hand-authored ground truth**;
`corpus/generated/**` is LLM-written prose expressing it; `corpus/questions.yaml` derives
questions from fact IDs. Facts are authored **first** — never write a question by reading a
generated document. This ordering is what makes the eval suite meaningful rather than
circular, and it is what real benchmarks (HotpotQA, LoCoMo) do.

Setting: "Lumen Labs", a fictional company — 16 people, 3 customers, 6 projects, 15 channels.
169 documents (82 mail / 47 chat channel-days / 40 notes) across 9 storylines, ~100 of them
pure noise. 33 facts, some with `supersedes` chains to create temporal traps. 56 questions
across 5 categories including 8 deliberately unanswerable ones (abstention is scored).

Use `/add-fact` to extend the ledger — it encodes the required file order. A `PostToolUse`
hook auto-runs `pnpm corpus:generate --verify-only` on ledger edits.

---

## 4. Where we are right now

| Milestone | State | Notes |
| --- | --- | --- |
| M0.1–M0.4 declient/rename/license/init | ✅ | No client identifiers in any tracked file except PLAN.md §3. Permanent gate. |
| M0.5 corpus | ✅ | 169 docs generated + committed, all fact-bearing docs verify. |
| M0.6 rewire retrieval | ✅ | `source`/`doc_id` threaded migrations → repos → `RetrievalService`; `sourceFilter` on search. |
| M0.7 README | ✅ | Honest about state. |
| M1.1 provider adapter | ✅ | `LLM_SERVICE` token → `OpenAICompatibleProvider`; tiers in `model-tiers.ts`. |
| M1.2 embeddings + index identity | ✅ | `EMBEDDING_SERVICE` token, `index_meta`, boot-time identity check. |
| M1.3 the agent graph | ✅ | LangGraph `StateGraph` + tool registry + 5 nodes. Verified live against the real corpus. |
| M1.4 SSE surface | ✅ | `POST /agent/ask` (SSE), `GET /agent/runs/:runId`. Event contract frozen. |
| Provider failover | ✅ | Pulled forward from §9 — free-tier quota was killing ~half of all runs. `gemini → groq` chain, verified live. |
| Lint / typecheck | ✅ | `pnpm lint`, bare `npx eslint .`, and `npx tsc --noEmit` all exit 0. 68 tests across 9 suites, plus 11 in `ui/` (which has its own ESLint — `next lint` was removed in Next 16). |
| **M2 UI** | ✅ | `ui/` — Next.js App Router + Tailwind, pure rendering over the frozen event contract. All seven panels; `?demo=1` replays with zero model calls. |
| **M3 observability** | ✅ | Local trace store, cost accounting and LangSmith, all verified live. Planner → tool → LLM confirmed on a real second-hop trace, [shared publicly](https://apac.smith.langchain.com/public/14204394-ae03-4e47-afb0-8ada1c2dd735/r/01a06fe7-641a-700e-8d18-34e5efc77473) and linked from the README. |
| **M4 memory** | ⬜ **← next task** | See PLAN.md §5. |
| M5 MCP · M6 evals+CI | ⬜ | See PLAN.md §5. |

### What a live run actually does (verified 2026-09-02)

Multi-hop — *"Why did the Helios launch slip, and who approved the new date?"*: triage says
`complex` → plans 2 sub-questions (`notes_search`, `mail_search`) → runs them in parallel →
10 pieces of evidence → `gapFound: false` → cited answer where all 5 citations resolve.
**~10s, 4.3k input tokens.**

Simple — *"When did Tariq Hassan start at Lumen Labs?"*: triage says `simple`, **no
`plan_created` event at all**, one broad retrieval, cited answer. **~4.5s.** That gap is the
triage node paying for itself, and it is a number M6 reports.

Unanswerable — the agent abstains with "I could not find this in the available sources."

**Second hop** — *"What did the board approve and what were the outcomes?"* is the known-good
multi-hop demo question: it plans, fans out across all three sources, and `reflect` returns
`gapFound: true` with a real follow-up retrieval. Only ~3 in 30 multi-hop questions trigger a
second hop, so use this one when you need to *show* the behaviour rather than hope for it.

**Run one before building against it.** `pnpm start:dev`, then:

```bash
curl -N -X POST localhost:5000/agent/ask -H 'Content-Type: application/json'   -d '{"question":"What did the board approve and what were the outcomes?"}'
```

Reading the real event stream for two minutes beats any description of it in this file.

### Provider choice changes agent *behaviour*, not just speed

Measured across the same corpus questions:

| | Gemini (`gemini-3.5-flash-lite`) | Groq (`openai/gpt-oss-20b`) |
|---|---|---|
| Second hop fires | ~3 of 30 multi-hop questions | 3 of 4 |
| Per-call latency | ~2–3s, fairly steady | 0.35s–19.7s, highly variable |
| Structured output | tolerant | strict; rejects non-compliant generations with a 400 |

Two consequences worth knowing before you tune anything:

- **Groq's gpt-oss reads a prose tool menu as function calling.** The reflect prompt used to say
  "Available tools for follow-up searches", and the model emitted an actual tool call — rejected
  with `400 Tool choice is none, but model called a tool`, because the request declares no tools.
  The prompts now name them as "search targets … labels to choose between, not functions to
  call". **Keep that framing** if you touch those prompts; it is what makes them portable.
- **This is why Gemini is primary** (§11.3). Groq's numbers look attractive until you capture
  runs on both: it trades away citations, and a 48s run breaks §1's 30-second target. The four
  fixtures in `fixtures/runs/` were captured on Groq and therefore show its weaker output —
  re-run `pnpm capture:runs --force` on Gemini when you want the demo to look its best.

`OpenAICompatibleProvider` also degrades gracefully now: a 400 on a request that carried a
`response_format` is retried once without it, letting `parseJsonObject` handle output the
provider would otherwise have rejected outright.

### Deviations from PLAN.md as written (deliberate — keep them)

- **Corpus verification is literal-token matching**, not the embedding-similarity check §6
  suggests. Rationale in `scripts/corpus-generate.ts`'s header: "did the exact date survive"
  is the actual failure mode, is fully deterministic, and needs no arbitrary cutoff.
- **Embeddings default to Gemini** (`gemini-embedding-001`, 768d). PLAN.md §11.4 originally
  locked _local in-process_ instead; that was formally superseded on 2026-09-04. The
  consequence is not cosmetic — §9's Docker build was designed to be offline and keyless
  because of that decision, and now needs a key. §9 carries a warning listing the three ways
  out. This is settled, not an open question, unless the keyless build turns out to matter.
- **The `deep` LLM tier maps to `gemini-3.5-flash`, same as `default`.** Every Gemini pro
  model returns 429 on the free tier, and free deployment is a hard constraint (§9). The tier
  seam stays so `LLM_MODEL_DEEP` can point a billed key at a pro model with no code change.
- **`CHUNK_SIZE` / `CHUNK_OVERLAP` are counted in _words_, not characters** (see
  `src/knowledge/chunker.ts`). At 700 words ≈ 4000 chars, every corpus document fits in a
  single chunk — the corpus is 169 docs of 300–1900 chars, so chunking is currently a no-op
  and retrieval is effectively whole-document. That is fine for this corpus, but do not
  assume the chunker has been exercised, and changing the units would invalidate
  `docs/retrieval-threshold-study.md`.
- `fact.security-finding-2` was split into a report fact and a `-resolution` fact — the
  original was unsatisfiable as authored (a disclosure email cannot state who would later fix
  the bug). **This is the pattern:** when verification flags a fact, first check whether the
  assigned document could plausibly express it at all — chronology, author, audience — before
  assuming the generator misbehaved.

### ⚠️ What is still unproven

- **`LLM_PROVIDER=ollama` has never run** — no local Ollama. Note the *substance* of that M1
  criterion is proven: a run served by Gemini and one served by Groq differ only by config.
- **OpenRouter's model ids in `model-tiers.ts` are unverified.** No key has been exercised
  against them. Gemini's and Groq's were both stale when checked, so assume these are too.
- The second-hop rate is ~10% of multi-hop questions. It works; whether it *should* fire more
  is an M6 measurement, not a prompt-tuning exercise to do now.
- **A full live multi-hop run has not been watched end to end in the UI in one sitting.**
  Every panel is proven — the live path streamed triage → plan → two parallel tool calls →
  evidence into them before the provider stalled the reflect call to the 60s budget, and the
  complete runs render via `?demo=1` over the identical SSE path — but the two halves were
  observed in different runs. Re-confirm when quota is healthy.

`pnpm lint` and `pnpm test` pass clean (68 tests across 9 suites), as do `cd ui && pnpm lint`,
`cd ui && pnpm typecheck` and `cd ui && pnpm test` (11 tests). There is still no CI; it
arrives in M6.

### Dead ends — things already tried that did not work

Recorded so nobody spends the hour again:

- **`400 Tool choice is none, but model called a tool` (Groq gpt-oss) is not a schema problem.**
  Retrying without `response_format` does *not* fix it — the retry fails identically. The cause
  is prompt wording: a prose menu headed "Available tools" reads as function calling, and the
  model emits a real tool call the request never declared. Rewording to "search targets …
  labels to choose between, not functions to call" fixed it outright, with zero retries.
- **A simplified reproduction will not trigger either Groq 400.** Both the tool-call error and
  the schema-mismatch error only appear on the full prompts, with real evidence blocks and the
  real tool menu. Reproduce with `pnpm capture:runs --force`, not a minimal script.
- **LangGraph's auto-tracing traces neither the model calls nor the tools.** It is easy to
  set the `LANGSMITH_*` variables, see a trace appear, and conclude M3.1 is done — but that
  trace stops at the graph node. Model calls go through the raw `openai` SDK rather than a
  LangChain chat model, and the retrieval tools are plain functions; LangGraph knows about
  neither. The lower two levels exist only because `LangSmithTracing.wrapClient` wraps each
  provider's client with `wrapOpenAI` and `.traceTool` wraps each retrieval as a
  `retriever` run. Remove either and the hierarchy silently loses a level.
- **A LangSmith key is bound to a region, and a mismatch is indistinguishable from a bad
  key.** `LANGSMITH_ENDPOINT` defaults to US. An APAC (or EU) account's key gets a bare
  `403 Forbidden` from the US endpoint on *every* authenticated call — ingestion, project
  listing, key introspection — while unauthenticated endpoints like `/info` still return
  200, and the key's "Last Used At" in the UI never populates. It cost an hour on
  2026-09-05, chasing plan entitlement and workspace scoping, before the region was the
  answer. Regions: US `api.smith.langchain.com`, EU `eu.api.smith.langchain.com`,
  APAC `apac.api.smith.langchain.com`.
- **Raising `LLM_MAX_RETRIES` makes quota errors worse, not better.** Every attempt counts
  against the same budget: at 5 retries one synthesis call became six and exhausted the window
  faster than not retrying. It is 2 deliberately. Failover, not persistence, is what survives
  a quota wall.
- **`GET /agent/runs/:runId` was not a substitute for fixtures during development** —
  `AgentRunStore` was in-memory and emptied on every dev-server restart. M3 made it durable,
  so a run id now survives a restart. `POST /agent/ask?demo=1` is still what you want while
  iterating, because it costs nothing; the trace store costs a model call to populate.

### Free-tier quota is a real constraint, not a footnote

Gemini's free tier allows ~20 requests per window per model and **one agent run costs ~4 model
calls**. A burst of runs failed roughly half the time before failover existed. Two things
learned the hard way, both worth not re-learning:

1. **Retrying harder makes a quota 429 worse** — every attempt counts against the same budget.
   `LLM_MAX_RETRIES` is 2 for this reason. Retries are for transient 5xx.
2. **Model ids rot.** Gemini retired `gemini-2.0-flash-lite` and `text-embedding-004`; Groq
   retired the whole `llama-3.x` line. A stale id fails as a 404 at *call* time, not at boot.
   When calls start 404ing, check the provider's model list first.

Groq is markedly faster than Gemini (~350–700ms vs ~2–3s per call) and its free tier is more
generous, so `gemini → groq` is a reasonable default chain. `groq/compound*` does not support
structured output, which every node requires — do not reach for it.

## 5. Rules you must follow

From PLAN.md §0.3 — these describe the existing bar, match it:

- **No module-level singletons.** No `export const x = new X()`. Everything `@Injectable()`,
  wired through Nest DI.
- **No `process.env` outside `src/config/`.** New vars go into `src/config/env.schema.ts`
  (Zod) first, then get a typed getter on `AppConfigService`.
- **No `console.log`.** NestJS `Logger` / Pino.
- **No raw type casts at API boundaries.** Zod schema + validation pipe.
- **Business logic never imports `better-sqlite3`.** Depend on the ports in
  `src/repositories/ports/`, bound via DI tokens in `repositories.module.ts`.
- **No abstractions before a second implementation exists** (§0.4).
- Comments explain _why_, not _what_.
- **Never advance past a milestone's acceptance criteria.**

### Anti-goals — ask before building any of these (PLAN.md §2)

PostgreSQL/pgvector repositories · separate LLM provider classes + a router · hand-rolled
agent orchestration (LangGraph.js is the chosen dependency) · the two client
helpdesk/ticketing integrations · a separate guardrails repo (it is M6 here) · replacing the
synthetic corpus with a public dataset · gating the demo behind user-uploaded data.

### Public-repo gate

This repo is public and was converted from client work. The client identifiers listed in
PLAN.md §3 must never appear in any tracked file except PLAN.md itself. `.env` is
machine-local and holds real API keys — never commit it, never echo its contents.

---

## 6. Getting running

```bash
pnpm install
cp .env.example .env      # then fill LLM_API_KEY (and ideally GROQ_API_KEY + LLM_FALLBACK_PROVIDERS=groq)
pnpm start:dev            # dev server on :5000
pnpm build                # also: pnpm lint, pnpm test

pnpm corpus:generate --verify-only        # re-check the answer key, no model calls, seconds
pnpm corpus:generate --only=fact.<id>     # regenerate docs for one fact (needs GEMINI_API_KEY)

cd ui && pnpm install && cp .env.example .env.local
pnpm dev                  # UI on :3000 — open /?demo=1 to spend no quota
pnpm lint && pnpm typecheck && pnpm test
```

Local Ollama on `:11434` is only required when `LLM_PROVIDER=ollama` or
`EMBEDDING_PROVIDER=ollama`.

### Map of `src/`

| Path                | What lives there                                                        |
| ------------------- | ----------------------------------------------------------------------- |
| `src/config/`       | Zod env schema + `AppConfigService` — the **only** place env is read     |
| `src/repositories/` | `ports/` (interfaces + DI tokens), `sqlite/` (adapters)                  |
| `src/database/`     | connection, migrations, boot-time index identity check                   |
| `src/knowledge/`    | markdown loader (gray-matter frontmatter), chunker, idempotent indexing  |
| `src/rag/`          | `RetrievalService` — vector search over sqlite-vec, with `sourceFilter`  |
| `src/ai/llm/`       | `LLM_SERVICE` token, one OpenAI-compatible client per provider, failover chain, tier-to-model map |
| `src/embeddings/`   | `EMBEDDING_SERVICE` token, gemini + ollama providers                     |
| `src/agent/`        | **the graph** — state, nodes, tools, events, SSE controller              |
| `src/agent/examples/` | `corpus/questions.yaml` projected for the UI's one-click examples      |
| `ui/`               | the M2 UI — its own package, its own lockfile, its own toolchain        |
| `corpus/`           | ledger (ground truth) + generated docs + questions                       |
| `evals/`            | eval harness — empty until M6                                            |
| `scripts/`          | authoring tools, run outside the Nest context                            |

### The seams you will actually use

```ts
@Inject(LLM_SERVICE)       llm: LlmService;
// llm.chat(messages, { tier: 'fast' | 'default' | 'deep', jsonSchema })

@Inject(EMBEDDING_SERVICE) embeddings: EmbeddingProvider;
// embeddings.embed(texts), .dimensions, .modelId

RetrievalService.search(query, topK?, sourceFilter?)
// sourceFilter: ('mail' | 'chat' | 'notes')[]
```

---

## 7. Work against recorded runs, not live ones

**A live run costs ~4 model calls against a free tier measured in tens per minute.** Iterating
on anything downstream of the graph against live runs burns quota within the hour, and it runs
out mid-demo rather than mid-development. So `POST /agent/ask?demo=1` replays a recorded run
instead — same route, same event stream, zero model calls.

```bash
curl localhost:5000/agent/demo          # what is available, with labels and durations
curl -N -X POST 'localhost:5000/agent/ask?demo=1' -H 'Content-Type: application/json'   -d '{"question":"What did the board approve and what were the outcomes?"}'
```

Four fixtures in `fixtures/runs/`, chosen to cover every state the UI has to render — simple
(no plan), multi-hop, second hop, and abstention. `pnpm capture:runs` re-records them against
a live server; `--list` shows the catalogue without spending anything.

Three things to know about it:

- **A replay always emits `run_replayed` first**, carrying the slug, the true capture time, and
  a reason. That is the honesty mechanism for PLAN.md §9's degraded demo — a recording cannot
  present itself as live. The UI renders a banner from it; do not remove that.
- **`seq` and `ts` are re-stamped** to the replay, so elapsed-time maths works normally. The
  original capture time is in `run_replayed.capturedAt`.
- **Gaps longer than 2s are clamped**, so a replay is quicker than the original run without
  losing its pacing — a 48s recording replays in about 7s.

Fixtures reload when the files change, so `pnpm capture:runs` takes effect without a restart
(`nest start --watch` watches `src/`, not `fixtures/`).

## 8. The UI (`ui/`)

Its own package, its own lockfile, its own toolchain — Next.js 16 App Router, React 19,
Tailwind v4. It deploys to Vercel while the API deploys to HF Spaces, so **the browser always
makes a cross-origin request** and `NEXT_PUBLIC_API_URL` is the only thing it needs to know.

```bash
cd ui && pnpm install
cp .env.example .env.local
pnpm dev            # http://localhost:3000 — open /?demo=1 to spend no quota
pnpm lint && pnpm typecheck && pnpm test
```

### How it is put together

```
ui/lib/agent-events.ts   mirror of src/agent/events.ts — see the warning below
ui/lib/sse.ts            fetch + hand-rolled SSE frame parser (EventSource cannot POST)
ui/lib/run-state.ts      the reducer: events -> RunView. All the real logic is here
ui/lib/presentation.ts   source colours, category labels, formatting
ui/lib/api.ts            askStream(), fetchExamples(), fetchDemoRuns()
ui/components/           one panel each; none of them fetch anything
ui/app/page.tsx          the only stateful component
```

### Seven things that will bite you

- **There are two hand-kept mirrors, and only one of them is pinned.**
  `ui/lib/agent-events.ts` mirrors `src/agent/events.ts`, and `ui/lib/run-state.test.ts`
  replays the real `fixtures/runs/*.json` through the reducer, so drift fails there rather
  than in a browser. `ui/lib/api.ts` mirrors `src/agent/examples/example-question.ts` and
  **nothing checks it** — which is why `QuestionCategory` there is deliberately an open
  string type: a category added on the API side renders with its raw name instead of
  disappearing from a list that still counts it.
- **Citation markers are not evidence positions.** `synthesize` sorts evidence by distance and
  truncates before numbering it, so `[5]` is routinely *not* the fifth chunk retrieved. Build
  marker maps from the `citations` array only (`markersByEvidenceId`). There is a test pinning
  this because the failure is silent and sends every chip to the wrong card.
- **`distance` is lower-is-better** and is not normalised to 0–1. `relevanceFraction()` inverts
  it against the band this corpus occupies purely so the bars are comparable; the number beside
  the bar stays the real distance, and the label says "d" rather than "score" on purpose. The
  band is measured off the committed fixtures (0.406–0.585 on `gemini-embedding-001` at 768d)
  and is **not portable across embedding models** — re-measure it if `EMBEDDING_MODEL` changes.
- **The tool timeline is scaled to the retrieval window**, not the whole run. Model calls
  dominate wall-clock — a 26s run can finish all its retrieval inside 4s — so scaling to the
  run squeezes every bar into a sliver and destroys the one thing the chart exists to show.
  Total run time lives in the stats panel instead.
- **An empty `citations` array is not an error.** The agent abstaining is a scored outcome.
- **An empty `evidenceIds` on `tool_finished` is not a failure either.** A search can
  legitimately match nothing. Only `tool_finished.error` separates the two, and it exists
  because `status: 'failed'` never leaves graph state — `plan_created` and `reflect_done` are
  emitted *before* execution. Treat the two alike and the UI reports a failed retrieval as a
  completed one, which is the opposite of what this UI is for.
- **Aborting a stream does not reliably raise.** One chunk carries several SSE frames, and
  those are already decoded — so a consumer that only catches `AbortError` keeps applying
  events after the caller walked away. `lib/sse.ts` checks `signal.aborted` per *frame*, and
  `app/page.tsx` re-checks it after the loop. Without both, Stop is undone by a buffered
  `run_finished`.

### What the API gained for it

- `GET /agent/examples` — the authored question set, projected to what a chip needs, plus a
  `demoSlug` where a recording exists. `referenceAnswer` and `requiredFacts` are **never**
  served: they are the answer key.
- `run_finished` now carries optional `models: string[]` (`provider/model`, first-use order),
  fed by a new `provider` field on `ChatResult`. A list because failover changes vendor
  mid-run — `groq/openai/gpt-oss-20b → gemini/gemini-3.5-flash` in one run is observed, not
  hypothetical. Optional because the committed fixtures predate the field.

## 9. What to do next

**M4 — memory** (PLAN.md §5). M3 is complete and closed out:

- `runs` + `run_spans` in sqlite behind a `TraceRepository` port, bounded by
  `TRACE_RETENTION_RUNS`, capturing failed runs as well as successful ones.
- Per-call cost from `src/config/model-prices.ts`, prices verified against provider pages.
- LangSmith tracing verified live, with the public trace linked from the README.

Read that trace before starting M4 — it is the fastest way to see the graph's actual shape,
including the second hop:
https://apac.smith.langchain.com/public/14204394-ae03-4e47-afb0-8ada1c2dd735/r/01a06fe7-641a-700e-8d18-34e5efc77473

### Known gaps worth closing along the way

- **`POST /agent/ask` has no rate limit and CORS is open to any origin** (`main.ts`). Both were
  deliberate for local dev and both are still open. This is the endpoint a public UI now points
  at, so it needs revisiting before deployment — it was left alone in M2 because rate limiting
  is a new dependency and a scope call, not because it is fine.
- **The M2 live-run acceptance check was only verified in halves.** Free-tier providers would
  not hold a full live multi-hop run open on the day: a live run streamed triage → plan → two
  parallel tool calls → evidence into the panels before the reflect call stalled to the 60s
  budget, and complete runs render end to end via `?demo=1` over the identical SSE path. Worth
  re-confirming in one shot when quota allows.
- `token_delta` still fires once with the whole synthesised answer. Real token streaming needs
  an `LlmService.chatStream`; the UI already accumulates deltas, so it gets per-token rendering
  for free the day that lands.
- ~~`AgentRunStore` is in-memory and capped at 100 runs.~~ Closed in M3 — runs and spans go
  to sqlite, and failed runs are captured too, which the in-memory store never did.
- **§9 still needs a decision about the baked image.** `TRACE_RETENTION_RUNS` bounds the
  table, but a bounded set of *your development questions* still ships inside
  `database/app.db`. Either clear the trace tables when baking, or accept it.
- ~~`POST /agent/ask` does not stop the run when the client hangs up.~~ Fixed 2026-09-05, and
  the cause is worth keeping: **`request.on('close')` is not a disconnect signal.** Since Node
  16 an `IncomingMessage` emits `close` when the request stream *completes* — i.e. the moment
  the JSON body has been read — so it fired ~2ms into every run. That went unnoticed for a
  second reason: it aborted the caller signal before `AgentGraphService.run()` subscribed to
  it, and `addEventListener` never fires for an event that already happened, so the graph
  ignored it. Two bugs, each hiding the other; fixing only the second would have made *every*
  run abort instantly. The controller now listens on `response`, which emits `close` when the
  socket actually goes away, and the graph checks `signal.aborted` before subscribing. Both
  halves are covered in `agent-graph.service.spec.ts` under "cancellation".

  Measured after the fix, and the pair is what makes it convincing: a run whose client hung
  up at 3s died at **3005ms** (reflect 1ms, synthesize 2ms — the drain collapsing), while a
  run whose client stayed connected was untouched by it and ran the full **60s** budget
  before the *timeout* aborted a stalled synthesis. A premature `close` would have killed
  the second one at ~0ms.
- ~~The trace store has no retention bound.~~ Fixed 2026-09-05: `TRACE_RETENTION_RUNS`
  (default 200) prunes oldest-first inside the same transaction as the insert, with
  `run_spans` following via `ON DELETE CASCADE`.
- **CLAUDE.md's published `process.env` grep now returns hits.** `src/observability/
  langsmith-tracing.service.ts` *writes* `LANGSMITH_*` back into the environment for
  LangGraph and the LangSmith wrapper, which read it themselves; every value comes from
  `AppConfigService` and every variable is declared in `env.schema.ts` first, so the rule (no
  *reads* outside `src/config`) holds. `src/logger/logger.module.ts` reads `NODE_ENV`
  directly and is a genuine long-standing hit. M6's CI gate needs a read-only pattern or an
  explicit exemption for these two, or it lands red on day one.
- `RETRIEVAL_DISTANCE_THRESHOLD` is configured but **not enforced** — it must be re-derived for
  the current embedding model first. See the comment in `src/config/env.schema.ts`.
- `LLM_PROVIDER=ollama` is still unexercised, for lack of hardware.


## 10. Working with this repo as an agent

- Read the **section** of PLAN.md you need. It is ~1100 lines; do not read it whole.
- Section index is in `CLAUDE.md`. Locked decisions are §11 — do not re-litigate them.
  Deferred backlog is §12 (includes BYO-data upload, deliberately post-M2).
- Two subagents exist: `plan-compliance-reviewer` (checks a change against §0 rules, §2
  anti-goals and the client-reference gate) and `corpus-ledger-auditor` (catches ledger
  defects the literal-token verifier cannot — implausible fact assignments, broken
  `supersedes` chains, questions whose `requiredSources` contradict their facts).
  Run the compliance reviewer before committing anything substantial.
- Skills: `/add-fact` (extends the ledger in the required file order), `/milestone-check`.
- Hooks: corpus verification on ledger edits, protected-file guard, format-on-write.
