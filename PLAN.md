# PLAN.md — Throughline: Agentic RAG over scattered personal/work data

> **Name:** `throughline` — the narrative thread connecting scattered evidence into one
> answer. Decided (§11.1); use it everywhere below, including `package.json`, the repo name,
> and deployed URLs.

**Audience:** an AI coding agent (or the repo owner) executing this plan with no prior context
on the repository. Everything needed to start is in this document.

---

## Current status — read this first

*Authored 2026-08-04. Status last updated 2026-09-06.*

**Repo:** https://github.com/UditUchiha/throughline (public, one clean commit, no client data
in history). Local dev on Windows, pnpm, Node 22.

| Milestone | State | Notes |
|---|---|---|
| **M0.1–M0.4** | ✅ Done | Client code/data deleted; renamed to `throughline`; MIT licensed; `git init` + first commit pushed. Retrieval-threshold study preserved at `docs/retrieval-threshold-study.md` (aggregate numbers only, no customer text). |
| **M0.5 — corpus** | ✅ Done | 169 documents generated and committed (82 mail / 47 chat / 40 notes). All fact-bearing documents pass verification — re-check anytime with `pnpm corpus:generate --verify-only` (reads the corpus on disk, no model calls, seconds). |
| **M0.6 — rewire retrieval** | ✅ Done | `source`/`doc_id` threaded through migrations → `ChunkRepository` → `RetrievalService` → `RetrievedChunk`; frontmatter parsed via `gray-matter`; `sourceFilter` on `EmbeddingRepository.search`; `KNOWLEDGE_PATH` → `./corpus/generated`. |
| **M0.7 — README v1** | ✅ Done | Honest about current state; points here for the roadmap. |
| **M1.1 — provider adapter** | ✅ Done | `LLM_SERVICE` token → one `OpenAICompatibleProvider`; logical tiers in `model-tiers.ts`. |
| **M1.2 — embeddings + index identity** | ✅ Done | `EMBEDDING_SERVICE` token, gemini + ollama providers, `index_meta` identity written on reindex and checked at boot. |
| **M1.3 — the agent graph** | ✅ Done | LangGraph `StateGraph`: triage → (plan) → execute → reflect ↺ → synthesize. Tool registry with `mail_search` / `chat_search` / `notes_search` / `all_sources_search`. |
| **M1.4 — streaming HTTP surface** | ✅ Done | `POST /agent/ask` (SSE) and `GET /agent/runs/:runId`. Event contract frozen in `src/agent/events.ts`. CORS enabled. |
| **Provider failover** | ✅ Done | Pulled forward from §9 because free-tier quota was killing ~half of all runs. `LLM_FALLBACK_PROVIDERS` + `FailoverLlmService`. |
| **Recorded-run replay** | ✅ Done | Also pulled forward from §9. `POST /agent/ask?demo=1` replays a fixture; `GET /agent/demo` lists them; `pnpm capture:runs` records them. Lets M2 be built without spending quota, and is the degraded-demo path. |
| **M2 — UI** | ✅ Done | `ui/` — Next.js App Router + Tailwind, pure rendering over the frozen event contract. Question box + one-click examples, plan panel with the hop grouping, tool timeline, evidence grouped by source, citation chips that scroll to and highlight their evidence, memory placeholder, run stats. `?demo=1` replays with zero model calls. Two supporting API additions — see the deviations below. |
| **M3 — observability** | ✅ Done | Local trace store done and tested (`runs` + `run_spans`, `TraceRepository` port, `TraceCollector`; replaces the in-memory `AgentRunStore`, and captures failed runs too). Cost/token accounting done, prices verified against provider pages. LangSmith verified live — planner → tool → LLM nesting confirmed on a real second-hop run, shared publicly and linked from the README. |
| **M4.1 — short-term memory** | ✅ Done | LangGraph checkpointer (`@langchain/langgraph-checkpoint-sqlite`) keyed by `sessionId` over the existing connection; a `recall` node ahead of `triage` resolves follow-ups against the checkpointed turns. `sessionId` appended to `run_started` and plumbed through the UI, which had never sent one. `memory_read` / `memory_written` now carry real refs. Retention bounded by `CHECKPOINT_RETENTION_SESSIONS`. |
| **M4.2 — long-term memory** | ✅ Done | `LongTermMemoryService` — extract → score → dedup → store, with funnel counters at `GET /memory/stats`; consolidation job merges near-duplicates and forgets facts unused past `MEMORY_TTL_DAYS`. Facts get their own table + vec index rather than living in `chunks` (see the deviation below). Verified live across sessions. |
| **M5 — MCP connectors** | ✅ Done | `McpHostService` connects to configured servers at boot, discovers their tools and registers them into the existing registry. **No file under `src/agent/nodes/` changed** — the M1 tool shape held; the only structural change was making the `AGENT_TOOLS` factory async. `DEMO_MODE` (default on) serves a real in-process MCP server over the SDK's in-memory transport, so the credential-free demo exercises the whole path rather than bypassing it. Security section built: allowlisted tool surface, schema-validated arguments, retrieved content fenced as untrusted, and 3 adversarial corpus documents carrying real payloads. Verified live both ways — the planner chose the connector unprompted and cited it, and an injected document was described rather than obeyed. |
| **M6 — evals + guardrails + CI** | ✅ Done; measured 2026-10-04 | `evals/` written from scratch, `src/guardrails/` with five deterministic checks running on every live run *and* scored by the suite, and two GitHub Actions workflows. **The agent-vs-baseline delta is measured**, closing the criterion that was outstanding: 59 questions against a single-shot control through identical scoring, 0 runs failed in either mode, connectors off *verified* off the booted application after the isolation bug was fixed. **The control wins** — recall@k 96.4% vs 100%, answer correctness 65.4% vs 77.6% — and the suite localised why, which is the point of having one. Two caveats are recorded wherever the numbers appear: 26 of 59 agent questions carry a judge verdict (free-tier quota), and injection resistance reads 87.5% because `tokenLeaked` is a substring test that cannot tell a quoted canary from an obeyed one. Judge agreement remains un-run (20 calls). |
| **§9 — deployment** | ✅ Built | Dockerfile (index baked in, keyless build via committed vectors), `render.yaml`, rate limit on `POST /agent/ask`, long-term memory off publicly, and the recorded-run fallback wired to an exhausted quota. Image built, booted and exercised in a container; a CI job now does the same on every push. **Deployed 2026-10-04** — API on Render, UI on Vercel, both auto-deploying from `main`; the hero question verified replaying against production. |

> [!WARNING]
> **The eval harness's environment isolation never took effect, for the whole of M6** (found
> 2026-09-06 while building §9). `@nestjs/config` reads `process.env` inside the `@Module`
> decorator of `src/config/config.module.ts`, so it snapshots the environment when that file is
> *imported*. `evals/harness/context.ts` imported `AppModule` at the top of the file and only
> then called `applyEnvironment()` — so every setting it made was written into a `process.env`
> nobody would read again.
>
> Three consequences, all verified against the committed artifacts rather than reasoned about:
>
> 1. **The suite ran with connectors ON while recording `connectors: false`.**
>    `evals/results-latest.json` says `"connectors": false` and contains 14 references to
>    `obsidian_search_notes`. Two of 59 questions retrieved from the demo vault —
>    `q.tariq-hire-and-start` and `q.ceo-favorite-hobby`, the second an abstention question.
>    Neither cited the vault evidence, so the headline scores are probably intact; but the
>    planner saw a four-tool menu on all 59, not the three the results describe. This is exactly
>    the failure `evals/README.md` argues against, arrived at by a different route.
> 2. **Eval traffic went into `database/app.db`,** not the isolated copy. `database/evals.db` and
>    `database/app.db` are byte-identical with the same 81 runs: the copy was made and then never
>    written to.
> 3. `LANGSMITH_TRACING=false` did not apply either.
>
> **Fixed**: `AppModule` is now loaded with a deferred `require` after the environment is set
> (`await import()` cannot be used — under `module: nodenext` TypeScript emits a genuine ESM
> dynamic import even from a CommonJS file, and Node's ESM resolver rejects an extensionless
> specifier), and `verifyEnvironment` reads the settings back off the booted `AppConfigService`
> and throws before the suite spends ~350 model calls. Trusting the flag is what failed; checking
> it is cheap.
>
> **Discharged 2026-10-04.** The suite was re-run against both modes with the isolation fix in place and `verifyEnvironment` checking the settings off the booted application rather than trusting the flags. The numbers in the README, HANDOFF and §10 are from that run; the figures this warning was about are gone from every live claim and survive only where the text is recounting the bug itself.
> Until then the README's figures should be read as "measured with the demo connector live".

> [!NOTE]
> **The embedding/retrieval path is now proven end-to-end** (2026-09-02, resolving the
> standing warning that sat here). All 169 corpus documents indexed against
> `gemini-embedding-001` at 768d; a re-run skipped 169/169 by checksum; retrieval returns
> sensible ranked hits; and `sourceFilter` executed for real via the agent's per-source
> tools. Live agent runs answered a multi-hop question (2 sub-questions, 2 sources, 10
> pieces of evidence, all citations resolving) in ~10s and a simple one in ~4.5s.
>
> Two things surfaced while proving it, both fixed:
> 1. **The Gemini model ids in `model-tiers.ts` had been retired by Google**
>    (`gemini-2.0-flash-lite`, and `text-embedding-004` in `.env.example`). A stale id fails
>    as a 404 at call time, not at boot. Current: `gemini-3.5-flash-lite` / `gemini-3.5-flash`,
>    and `gemini-embedding-001` for embeddings. **Gemini pro models return 429 on the free
>    tier**, so the `deep` tier maps to `gemini-3.5-flash`; the seam stays for a billed key.
> 2. **The index-identity guard compared two differently-built strings** — the writer stored
>    `gemini/gemini-embedding-001:768` while the boot check looked for
>    `gemini-embedding-001:768`, so it refused to boot against an index it had just built
>    correctly. Both sides now go through `embeddingIdentity()` in
>    `src/embeddings/embedding.types.ts`, covered by `embedding-identity.spec.ts`.

> [!NOTE]
> **Free-tier quota turned out to be the dominant failure mode, and is now handled**
> (2026-09-04). Measured: Gemini's free tier allows ~20 requests per window per model, and one
> agent run costs ~4 model calls — so a burst of runs failed roughly half the time. Two
> findings worth keeping:
> 1. **Retrying harder makes a quota 429 worse.** Every attempt counts against the same
>    budget, so `LLM_MAX_RETRIES=5` turned one synthesis call into six and exhausted the
>    window faster than not retrying. It is now 2. Retries are for transient 5xx, not quota.
> 2. **The only real answer is another provider**, exactly as §9 says. `LLM_FALLBACK_PROVIDERS`
>    now takes an ordered chain; `FailoverLlmService` moves to the next provider on quota/5xx/
>    connection errors and rethrows 4xx immediately (a malformed request follows you to the
>    next vendor). Verified live: 6 concurrent runs, the same burst that previously killed
>    8/8, now 6/6 with the log showing `gemini → groq` failover.
>
> **Groq's shipped model ids were also stale** (`llama-3.x` retired). Now `openai/gpt-oss-20b`
> / `openai/gpt-oss-120b`, verified to support strict `json_schema`, and 4–5× faster than
> Gemini. `groq/compound*` does **not** support structured output — do not reach for it.
> OpenRouter's ids in `model-tiers.ts` remain unverified; no key has been exercised.

> [!WARNING]
> **One M1 acceptance criterion remains unverified:** `LLM_PROVIDER=ollama` has never run, for
> lack of local hardware. The *substance* of that criterion — that switching providers needs
> no code change — is now proven, since a run served by Gemini and a run served by Groq differ
> only by configuration. The Ollama path specifically is still untested.
>
> A live second hop **is** proven: 3 of 30 multi-hop corpus questions produced
> `reflect_done { gapFound: true }` and a real follow-up retrieval. Good demo question:
> *"What did the board approve and what were the outcomes?"* The ~10% rate is deliberately
> not tuned — M6 is what can measure whether extra hops improve answers, and adjusting the
> reflect prompt before then is guessing.

**Decisions locked since authoring** (do not re-litigate — see §11):
- §11.1 Project name: `throughline`.
- §11.3 Default chat provider: **Gemini primary, Groq fallback** (locked 2026-09-04). Groq was
  primary for a day; see §11.3 for the measurements that reversed it.
- §11.4 Default embedding provider: **Gemini** (`gemini-embedding-001`, 768d). The original
  "local in-process" lock was superseded 2026-09-04; the local provider was never written.
  This forfeits §9's offline, keyless Docker build — see the warning there.
- §11.2 Corpus setting: accepted as "Lumen Labs" — see §6 and the anti-goal in §2 about
  swapping it for a public dataset.

**Known deviations from this plan as written** (deliberate, keep them):
- `scripts/corpus-generate.ts` verifies facts survived generation by **literal token
  matching** (ISO dates, dollar amounts, `4x`-style multipliers, known entity names extracted
  from each fact statement) rather than §6's suggested embedding-similarity check. Rationale
  is in the script's header comment: an embedding threshold is a fuzzy topical-relevance
  proxy needing an arbitrary cutoff, whereas "did the exact date survive" is the actual
  failure mode and is fully deterministic with no embedding calls.
- The corpus is 172 documents (83 mail / 48 chat channel-days / 41 notes) rather than §6's
  literal counts. Chat documents are channel-*days* containing 3–7 messages each, so total
  message volume lands in the intended range.
- **M2 added two things to the API that the plan describes but does not enumerate.**
  §5/M2 asks for example questions "from `corpus/questions.yaml`" and for run stats showing
  "provider/model used", and neither was reachable from a UI that deploys separately:
  1. `GET /agent/examples` projects the question set to `{id, question, category,
     requiredSources, minHops, expectedAbstention}` plus a `demoSlug` where a recording
     exists. `referenceAnswer` and `requiredFacts` are deliberately **not** served — they
     are the answer key, and an endpoint handing them out invites the graded answer into a
     prompt.
  2. `ChatResult` now carries the `provider` that served the call, and `run_finished`
     carries an optional `models: string[]` of every `provider/model` used, in first-use
     order. A list rather than one value because failover changes vendor mid-run — a run
     served by `groq → gemini` is a real and observed case. The field is **optional** on
     the event because the contract is append-only and the four fixtures in
     `fixtures/runs/` predate it; the UI shows nothing there rather than inventing a value.
  3. `tool_finished` gained an optional `error`. Without it a failed retrieval is
     indistinguishable on the wire from one that matched nothing — both carry
     `evidenceIds: []` — and `status: 'failed'` never leaves graph state, because
     `plan_created` and `reflect_done` are both emitted *before* execution runs. The UI was
     consequently rendering a thrown tool call as a completed sub-question, which is the
     inverse of what M2 exists to demonstrate. Also emitted for the unknown-tool branch,
     which previously emitted nothing at all and left the sub-question pending forever.
- **The UI mirrors the event contract rather than importing it.** `ui/lib/agent-events.ts`
  is a hand-kept copy of `src/agent/events.ts`. Importing across the boundary would couple
  two independent deployments at build time. `ui/lib/run-state.test.ts` replays the real
  `fixtures/runs/*.json` through the UI reducer, so a contract change the UI has not
  followed fails there rather than in a browser.
- **Citation markers are never derived from evidence arrival order.** `synthesize` sorts
  evidence by distance and truncates before numbering it, so `[5]` is routinely *not* the
  fifth chunk retrieved — measured on `second-hop-board-outcomes`, where marker 5 is
  `ev-160` and the fifth arrival is `ev-161`. The UI builds its marker map from the
  `citations` array only. There is a test pinning this, because the failure is silent and
  points every chip at the wrong card.
- `fact.security-finding-2` was **split** into a report fact and a
  `fact.security-finding-2-resolution` fact during M0.5. The original bundled "reported on
  2025-11-12", "fixed by Ben Holt", and "no bounty was paid" into one statement assigned
  solely to the researcher's disclosure email — which cannot state who would later fix it or
  what the bounty decision would be, because neither had happened when it was written. The
  answer key was unsatisfiable as authored; the verification pass caught it. A follow-up
  document (`mail.thread-security-disclosure-openredirect.msg-2`) now carries the resolution.
  **This is the pattern to follow if verification flags a fact: check whether the assigned
  document could plausibly express it at all before assuming the generator misbehaved.**

---

## 0. Rules of engagement

Read this section before writing any code.

1. **This repo is being converted from a client project into a public portfolio project.**
   The goal is not "more features." The goal is a repository a stranger can clone, run, and
   understand in ten minutes, and that demonstrates specific, measurable engineering judgment.
2. **Ship something demoable at every milestone.** If work stops at any milestone boundary,
   what exists must still be a coherent, linkable, runnable project. This is the single most
   important sequencing constraint and it overrides architectural tidiness.
3. **Preserve the existing code quality bar.** The current codebase has: NestJS dependency
   injection everywhere, a ports/adapters repository pattern, Zod-validated environment
   config, Pino structured logging, and comments that explain *why* rather than *what*.
   Match that bar. Specifically:
   - No module-level singletons (`export const x = new X()`). Everything is `@Injectable()`.
   - No `process.env` reads outside `src/config/`. Everything goes through `AppConfigService`.
   - No `console.log`. Use the NestJS `Logger` / Pino.
   - No raw type casts at API boundaries. Zod schema + validation pipe.
   - Business logic never imports `better-sqlite3` directly — it depends on repository ports.
4. **Do not add abstractions before a second implementation exists.** The prior version of
   this plan proposed four LLM provider classes and a router before anything used more than
   one. See §2 for why that is being rejected.
5. **Every milestone has acceptance criteria.** Do not advance until they pass.
6. **Ask before deviating on anything in §2 (Anti-goals).** Those are deliberate exclusions,
   not oversights.

---

## 1. What this project is

### One-sentence pitch

> An agentic RAG system that answers questions about your scattered work data — email, chat,
> and notes — by planning a multi-step retrieval strategy, gathering evidence from several
> sources, and producing a single cited answer, with full execution tracing and an
> eval-gated CI pipeline.

### Why this framing

The predecessor of this repo was a support-reply drafter for one customer's knowledge base:
single source, single hop, one domain. That demonstrates RAG plumbing but not agency. The
reframe keeps every good piece of the existing pipeline and adds the thing that makes it
interesting: **questions whose answers are not in any single document.**

### The demo that has to work

A stranger opens the deployed URL, types a question, and watches — live — as the system:

1. Decides the question needs decomposition, and shows the sub-questions.
2. Fans out to multiple source tools in parallel, showing each call and its latency.
3. Displays the retrieved evidence with relevance scores and source attribution.
4. Notices a gap and issues a follow-up retrieval (multi-hop).
5. Produces a final answer where every claim carries a citation that links back to the
   source document.
6. Shows what it remembered from earlier in the session and what it chose to persist.

No sign-in. No API key from the visitor. Pre-seeded data. Under 30 seconds.

**If a change does not move toward that demo, it is not in scope for M0–M4.**

---

## 2. Anti-goals — do not build these

These were in an earlier draft plan. They are deliberately excluded. Do not reintroduce them
without explicit approval from the repo owner.

| Excluded | Reason |
|---|---|
| **PostgreSQL + pgvector repository implementations** | The owner's resume already claims PostgreSQL and Prisma depth. Writing a second implementation of ports that already work adds no new capability, no new keyword, and roughly two days of work. SQLite + `sqlite-vec` is sufficient through M5. If a hosted vector store is needed later, see §9. |
| **Zoho Desk integration** | Client-specific work with no portfolio value, and it is the specific thing that would make this repo unpublishable. |
| **Four separate LLM provider classes + a router service** | Gemini, Groq, OpenRouter, DeepSeek, Cerebras and Ollama all expose OpenAI-compatible HTTP APIs. One client with a configurable `baseURL` plus a provider config map covers all of them. See M1.1. Anthropic requires a distinct code path; leave the interface shaped for it but do not implement it yet. |
| **Hand-rolled agent orchestration loop** | The earlier plan argued against LangGraph to avoid a dependency. Rejected: LangGraph.js provides the checkpointer (which is the short-term-memory persistence layer), streaming graph events (which is how the UI renders live progress), and first-class LangSmith tracing. Rebuilding those is thousands of lines, worse, and costs the recognizable ecosystem vocabulary. |
| **A separate "Guardrails + eval CI" repository** | Folded into this project as M6. A guardrail system evaluated against synthetic examples is a toy; evaluated against a real agentic system with real failure modes it is credible. See §8. |
| **Zammad ingestion pipeline** | Removed in M0. It is client data tooling. The code survives in the original client repo if ever needed. |
| **Replacing the synthetic corpus with a public dataset** (Enron, Kaggle, a scraped corpus) | Tempting because it feels "more real," but it destroys the eval suite. The expensive part of an eval set is the *answer key*, not the documents: a public dump gives you text with no "these 2 facts, in these 2 documents, are required to answer this" annotation. You would either hand-label it (weeks) or have an LLM label it — and then the eval is graded by the same model that wrote it, which measures nothing. Ledger-first synthesis is what purpose-built multi-hop benchmarks do when no annotated corpus exists for the domain (cf. LoCoMo, generated from a persona/event graph then verified; HotpotQA/MuSiQue's contribution is precisely the human-annotated supporting facts). **The facts here are human-authored; only the prose is generated; the generator verifies the facts survived.** Keep it. |
| **Gating the demo behind user-uploaded data** | See §12.1 — bring-your-own-data is a deferred post-M2 nice-to-have, not the answer to "what does a visitor ask." One-click example questions from `corpus/questions.yaml` solve that at zero cost. |

---

## 3. Current state inventory

Verified by reading the repository on 2026-08-04. An executing agent should re-verify before
relying on any specific line.

### Stack

- Node 22+, pnpm, TypeScript 5.7, NestJS 11
- `better-sqlite3` + `sqlite-vec` (v0 virtual table for KNN)
- `zod` v4 for env + DTO validation
- `nestjs-pino` for structured logging
- Jest configured (`rootDir: src`, `testRegex: .*\.spec\.ts$`) — **currently zero test files**
- **Not currently a git repository.** No history to scrub. `git init` in M0 produces a clean
  first commit with no client data in it, provided M0's deletions happen first.

### Module graph (`src/app.module.ts`)

```
ConfigModule, LoggerModule, RepositoriesModule, KnowledgeModule,
RagModule, SupportModule, SchedulerModule, IngestionModule
```

### Assets worth preserving

| Asset | Path | Why it stays |
|---|---|---|
| Repository ports + DI tokens | `src/repositories/ports/*.ts` | `ArticleRepository`, `ChunkRepository`, `EmbeddingRepository`, `IndexStateRepository`, bound in `src/repositories/repositories.module.ts` via `ARTICLE_REPOSITORY` etc. Clean seam; new stores plug in without touching callers. |
| Zod env config | `src/config/env.schema.ts`, `src/config/app-config.service.ts` | `validateEnv()` + typed getters. Extend, don't replace. |
| Chunker | `src/knowledge/chunker.ts` | Word-window chunking with overlap. |
| Idempotent indexer | `src/knowledge/indexing.service.ts` | Checksum-based skip, handles deletions. `reindexAll()` returns `{indexed, skipped, removed, totalChunks}`. |
| Retrieval | `src/rag/retrieval.service.ts` | `RetrievalService.search(query, topK?)` → `RetrievedChunk[]` with `distance`. Batches chunk + article hydration correctly. |
| Migrations | `src/database/migrations.ts` | `runMigrations(db, embeddingDimensions)` creates `articles`, `chunks`, `index_state`, and the `vec_chunks` `vec0` virtual table sized to the embedding dimension. |
| **Eval harness** | `evals/run-evals.ts` | The strongest existing asset. Boots a Nest application context, forces a reindex to avoid racing the background scheduler, scores intent accuracy and retrieval hit-rate, and runs a **threshold sweep** that recommends an optimal `RETRIEVAL_DISTANCE_THRESHOLD` by maximizing separation between relevant and irrelevant queries. Generalize this in M6; do not discard it. |
| LLM/embedding clients | `src/ai/llm/ollama-chat.service.ts`, `src/embeddings/ollama-embeddings.service.ts` | Thin `fetch` wrappers. `OllamaChatService` sets `think: false` (needed for hybrid reasoning models). Become one provider among several in M1.1. |

### Assets to delete in M0

| Path | Reason |
|---|---|
| `src/ingestion/**` (entire tree, ~700 LOC) | Zammad client ingestion |
| `scripts/zammad-*.ts` (4 files) | ditto |
| `scripts/import-pdf.ts` | One-off converter for a third-party manual |
| `knowledge/articles/<vendor-product>.md` | Third-party product manual, not owned |
| `knowledge/articles/zammad-qa/` (10k files) | Real customer tickets. **Already gitignored.** Delete from disk or leave untracked; never commit. |
| `ingestion/` (110,924 files) | Raw ticket JSON. **Already gitignored.** Leave on disk, untracked. |
| `prompts/classify-system.<vendor-product>.txt` | |
| `prompts/classify-system.ecommerce.txt` | Client intent taxonomy |
| `prompts/draft-system.txt`, `prompts/draft-template.txt` | Support-reply prompts, superseded |
| `evals/golden-set.json`, `evals/golden-set.de.json`, `evals/results-*.json` | Client-derived eval data. **Record the aggregate numbers in `docs/` before deleting** — see M0.4. |
| `src/support/**`, `src/ai/classification/**`, `src/ai/draft/**` | Support-drafting domain. Superseded by the agent. See M0.6 for the one piece to salvage. |
| `Archive.zip`, `HANDOFF.md`, `RUNBOOK.md`, `ZAMMAD-KB-INGESTION-PLAN.md`, `client-questions.md` | Client documentation |
| `.DS_Store`, `knowledge/.DS_Store` | |

### Client references in tracked source (must all be gone before first commit)

Grep for `zoho` and `zammad` (case-insensitive), **plus two further identifiers this document
deliberately no longer spells out**: the client's former package/repo name, and the third-party
product whose manual sat in the knowledge base. Both were scrubbed in M0 and removed from this
plan afterwards, so that a public reader of PLAN.md cannot recover them. If you need the literal
strings to re-run the check, ask the repo owner.

Known hits at time of writing: `src/config/env.schema.ts` (Zammad env vars + a comment naming
the client), `src/ingestion/zammad/signature.ts`, a vendor-specific classification prompt,
`evals/golden-set.json`, `.env.example`, `README.md`, and `package.json`'s `name` field.

**M0 acceptance includes: that grep returns zero hits across all tracked files.**

---

## 4. Target architecture

```
                    ┌─────────────────────────────────────┐
   Next.js UI ──────┤  POST /agent/ask     (SSE stream)   │
   (Vercel)         │  GET  /agent/runs/:id (replay)      │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │  LangGraph.js StateGraph            │
                    │                                     │
                    │   triage ─┬─► (simple) ──► retrieve │
                    │           └─► plan ──► fan-out      │
                    │                          │          │
                    │                    ┌─────▼──────┐   │
                    │                    │ tool calls │   │
                    │                    │ (parallel) │   │
                    │                    └─────┬──────┘   │
                    │                          │          │
                    │                     reflect ────────┼──► (gap? loop back, max N)
                    │                          │          │
                    │                     synthesize      │
                    └──────┬───────────┬──────────┬───────┘
                           │           │          │
                  ┌────────▼──┐  ┌─────▼────┐  ┌──▼─────────┐
                  │ Tool      │  │ Memory   │  │ Trace      │
                  │ Registry  │  │ STM/LTM  │  │ Collector  │
                  └────┬──────┘  └────┬─────┘  └──┬─────────┘
                       │              │            │
          ┌────────────┼──────┐       │        LangSmith
          │            │      │       │            +
      mail_search  chat_search│   checkpointer  trace store
      notes_search  (MCP, M5) │   + LTM facts   (for UI panel)
          │            │      │       │
          └────────────┴──────┴───────┴──► sqlite-vec index
                                              │
                          ┌───────────────────▼──────────────┐
                          │ LLM: OpenAI-compatible adapter   │
                          │ Gemini / Groq / OpenRouter /     │
                          │ Ollama  (one client, many hosts) │
                          └──────────────────────────────────┘
```

### Key design commitments

- **The graph is the product.** Everything else supports it.
- **Tools are uniform.** A tool is `{name, description, inputSchema, execute}`. Whether it
  hits the local index (M1–M4) or a live MCP server (M5) is invisible to the graph. This is
  what makes M5 an additive change rather than a rewrite.
- **Every retrieved chunk gets a stable `evidenceId`** the moment it enters agent state.
  Citations reference `evidenceId`, never free text. This makes citation validity a
  *deterministic* check, not an LLM judgment — see M6.
- **Streaming is not an afterthought.** The graph emits events as it runs; the HTTP layer
  forwards them over SSE; the UI renders them. Build the event contract in M1, before the UI
  exists, so M2 is pure rendering.

---

## 5. Milestones

Each milestone: goal → changes → acceptance criteria. Do not advance until acceptance passes.

---

### M0 — Declient, rename, seed corpus *(target: 1–2 days)*

**Goal:** a clean public repo with a synthetic corpus and working single-hop retrieval over
it. This is the foundation everything else assumes.

#### M0.1 — Delete

Delete everything in §3 "Assets to delete." Then remove the now-dangling references:

- `src/app.module.ts` — drop `SupportModule`, `IngestionModule` from `imports`.
- `src/config/env.schema.ts` — remove `ZAMMAD_BASE_URL`, `ZAMMAD_AUTH_TOKEN`,
  `ZAMMAD_OUTPUT_PATH`, `CLASSIFY_PROMPT_FILE`, and the client-naming comments on
  `EMBEDDING_MODEL` / `RETRIEVAL_DISTANCE_THRESHOLD`.
- `src/config/app-config.service.ts` — remove the corresponding getters.
- `package.json` — remove the four `zammad:*` scripts; set `"name": "throughline"`.
- `.env.example` — remove the Zammad block.
- Delete `evals/run-evals.ts`'s imports of `IntentClassifierService`. (The file is rewritten
  wholesale in M6; for M0 it is acceptable to delete it and re-add in M6, **provided M0.4
  captures its output first.**)

#### M0.2 — Rename and relicense

- `package.json`: name, description.
- New `README.md` (see M0.7).
- Add `LICENSE` — MIT, in the owner's name.
- Update `.gitignore`: keep existing entries, add `corpus/generated/.cache/`, `.env*.local`,
  `ui/.next/`, `ui/node_modules/`.

#### M0.3 — `git init`

```bash
git init
git add -A
git status   # MANUAL REVIEW REQUIRED before committing
```

**Before the first commit, manually verify `git status` lists no file under `ingestion/`,
`knowledge/articles/zammad-qa/`, or `database/*.db`.** The `.gitignore` already covers these,
but this is the one irreversible step in the plan — a client-data commit in history is
painful to remove. Verify, then commit.

#### M0.4 — Preserve the eval story before deleting the eval data

Create `docs/retrieval-threshold-study.md`. This records methodology and aggregate numbers
from the prior work **without any customer text**. It is a legitimate, publishable artifact
and it is the evidence behind a resume bullet. Content:

- The problem: deciding when retrieval grounding is too weak to trust.
- Method: golden set of 30 queries (22 with a known relevant section, 8 deliberately
  off-topic); measure the best (closest) chunk distance per query; sweep candidate cutoffs
  and pick the one maximizing separation.
- Result: relevant queries landed in 0.718–0.892; off-topic in 0.912–1.042 — a clean gap
  with no overlap, so a 0.90 cutoff separated them perfectly.
- The prior misconfiguration: threshold was 0.8, tuned for a 768-dim English embedding model
  and 300-word chunks; after switching to a 1024-dim multilingual model with 700-word chunks
  the old value silently misclassified relevant queries as ungrounded.
- The honest caveat: n=30 is small; the gap could close on real traffic.

**No customer queries, no ticket text, no client name.** Describe the domain generically
("a multilingual support knowledge base").

#### M0.5 — Design and generate the corpus

**This is the most important deliverable in M0. It is simultaneously the demo, the eval set,
and the proof the agent does anything.** Full specification in §6. Do not shortcut it.

Deliverables:
- `corpus/ledger/*.yaml` — hand-authored ground truth (entities, events, decisions, dates).
- `scripts/corpus-generate.ts` — expands the ledger into documents via an LLM, deterministic
  under a fixed seed.
- `corpus/generated/{mail,chat,notes}/**` — the generated documents, **committed to the repo**
  so a fresh clone works with no generation step.
- `corpus/questions.yaml` — the question set derived from the ledger, with per-question
  ground truth and required-source annotations.

#### M0.6 — Rewire retrieval to the corpus

- Point `KNOWLEDGE_PATH` at `corpus/generated/`.
- Extend `src/knowledge/markdown-loader.ts` to carry per-document frontmatter into a new
  `source` metadata field (`mail` | `chat` | `notes`) and a `docId`. This requires a
  `chunks.source` and `chunks.doc_id` column — add to `src/database/migrations.ts` and the
  `ChunkRepository` port.
- Extend `EmbeddingRepository.search()` to accept an optional `sourceFilter: string[]` so
  per-source tools can scope their retrieval. Implement in `SqliteEmbeddingRepository`.
- Salvage from the deleted `src/ai/draft/strip-boilerplate.ts`: the deterministic
  post-processing idea is worth keeping, but rewrite it for the new domain rather than
  porting the client-specific patterns. Low priority; can wait for M1.

#### M0.7 — README v1

Written for a stranger. Sections: one-sentence pitch, a screenshot placeholder, "what makes
this different from a RAG demo," quickstart (clone → `pnpm install` → `.env` → run → ask),
architecture diagram, and an explicit "current status: M0" note. Rewrite at every milestone.

#### Acceptance criteria — M0

- [ ] `grep -ril "zoho\|zammad" .` (excluding `.git/`, `node_modules/`, and gitignored dirs)
      returns **zero** hits, and so does the same grep for the two identifiers described but not
      named in §3.
- [ ] `git log` has exactly one commit; `git show --stat HEAD` contains no file under
      `ingestion/`, `knowledge/articles/zammad-qa/`, or `database/`.
- [ ] `pnpm build` succeeds with no TypeScript errors.
- [ ] `pnpm start:dev` boots with no `SupportModule` / `IngestionModule` errors.
- [ ] `POST /knowledge/reindex` indexes the generated corpus; reported chunk count is
      non-zero and stable across two consecutive runs (idempotency preserved).
- [ ] `GET /knowledge/search?q=<a question from corpus/questions.yaml>&k=5` returns chunks
      from the expected source document.
- [ ] `docs/retrieval-threshold-study.md` exists and contains no customer text.

---

### M1 — The agent graph *(target: 4–6 days)*

**Goal:** the differentiator. A LangGraph state machine that plans, fans out, reflects, and
synthesizes cited answers — streamed over SSE.

#### M1.1 — Provider adapter (a few hours, not a phase)

Add dependency: `openai` (used as a generic OpenAI-compatible client, not as an
OpenAI-only client).

**`src/ai/llm/llm.types.ts`**
```ts
export interface ChatOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  tier?: 'fast' | 'default' | 'deep';   // logical tier, not a model name
  jsonSchema?: object;                   // structured output when supported
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  costUsd: number | null;
}
```

**`src/ai/llm/openai-compatible.provider.ts`** — one `@Injectable()` class. Constructor takes
`AppConfigService`; builds an `OpenAI` client per configured provider with the right
`baseURL` and key. Known base URLs (**verify at implementation time — these move**):

| Provider | `baseURL` | Notes |
|---|---|---|
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | Free tier; **also serves embeddings** |
| Groq | `https://api.groq.com/openai/v1` | Free tier; fastest; open models |
| OpenRouter | `https://openrouter.ai/api/v1` | One key → many models incl. `:free` variants |
| Ollama | `http://localhost:11434/v1` | Local, offline, zero cost |

**`src/ai/llm/model-tiers.ts`** — maps logical tier → concrete model per provider, so calling
code says `tier: 'fast'` and never a model ID. Frequent cheap calls (triage, routing,
sub-question generation) use `fast`; synthesis uses `default`; the eval judge uses `deep`.

**Env additions** (`env.schema.ts` + `app-config.service.ts` getters):
```
LLM_PROVIDER=gemini|groq|openrouter|ollama
LLM_API_KEY=
LLM_MODEL_FAST=
LLM_MODEL_DEFAULT=
LLM_MODEL_DEEP=
EMBEDDING_PROVIDER=local|gemini|ollama
EMBEDDING_API_KEY=        # only read when EMBEDDING_PROVIDER=gemini
```

Keep `OllamaChatService` working via the same adapter (Ollama's `/v1` endpoint is
OpenAI-compatible). Preserve the `think: false` behaviour for hybrid reasoning models — if
the `/v1` path does not expose it, keep the native `/api/chat` path as a special case and
document why in a comment.

**Anthropic:** not implemented. Leave a `// TODO(anthropic): needs its own client` marker at
the provider switch so the seam is visible.

#### M1.2 — Embedding provider + index identity

> [!NOTE]
> **Superseded.** This subsection was written when §11.4 fixed the default embedding provider
> to local in-process. It shipped as Gemini instead (`gemini-embedding-001`, 768d) and the
> local provider was never written. The `fastembed` guidance below is kept because it is still
> the recipe if the keyless build is ever wanted back (§9, option 3) — but it describes a road
> not taken, not the code. **What did ship: the `EmbeddingProvider` interface, the Gemini and
> Ollama implementations, and the `index_meta` identity check**, which is the durable part.

**Original rationale, retained for the reversal case:** this is the one place where "which
cloud key" and "how the free deploy behaves" are the same decision, so the reasoning is worth
stating precisely.

Add dependency: `fastembed` (or `@xenova/transformers` — pick whichever has the smoother
Node/Docker story at implementation time; both run ONNX models in-process with no daemon and
no network call once the model file is cached). Default model: `bge-small-en-v1.5` (384d),
English-only, which is fine — the corpus in §6 is English by design, unlike the client KB
this repo is descended from.

**`src/embeddings/local-embedding.provider.ts`** — `@Injectable()`, implements
`EmbeddingProvider` (`embed(texts): Promise<number[][]>`, `dimensions`, `modelId`). Model
weights download once (either at `pnpm install` time via a postinstall, or lazily on first
use with an on-disk cache under e.g. `.cache/fastembed/`) — either way, **no key, no daemon,
no network call is required at container boot**, which is what keeps §9's Docker build
genuinely simple: `corpus-index.js` runs fully offline.

Also add, behind the same interface, for completeness of the "switchable" claim:
- `src/embeddings/gemini-embedding.provider.ts` — thin wrapper, only exercised when
  `EMBEDDING_PROVIDER=gemini`.
- The existing `src/embeddings/ollama-embeddings.service.ts`, adapted to the interface.

**Critical, and currently a latent bug regardless of which provider is default:** swapping
the embedding model invalidates the whole index because vector dimensions change, but nothing
detects this today. `EMBEDDING_DIMENSIONS` is a bare env var and a mismatch corrupts silently.

Fix: add an `index_meta` table (`embedding_model TEXT, dimensions INTEGER, created_at TEXT`)
in `src/database/migrations.ts`. On boot, compare against the configured provider. On
mismatch, **fail fast** with an actionable message ("index was built with `bge-small-en-v1.5`
(384d), config specifies `gemini-embedding-001` (1536d) — delete `database/app.db` and
reindex").

This is a small change and it is worth a paragraph in the README: it is the concrete cost of
the provider abstraction, and naming that cost is more convincing than pretending the
abstraction is free.

#### M1.3 — The graph

Add dependencies: `@langchain/langgraph`, `@langchain/core`.

**`src/agent/state.ts`** — the graph state annotation:
```ts
{
  question: string;
  sessionId: string;
  runId: string;
  complexity: 'simple' | 'complex';
  subQuestions: SubQuestion[];        // {id, text, tool, status, dependsOn?}
  evidence: Evidence[];               // {evidenceId, docId, source, text, score, retrievedBy}
  memoryUsed: MemoryRef[];
  hops: number;                       // guard against infinite reflect loops
  answer: { text: string; citations: Citation[] } | null;
  events: AgentEvent[];
}
```

**Nodes** (one file each under `src/agent/nodes/`):

| Node | Responsibility |
|---|---|
| `triage` | Cheap `fast`-tier call: is this simple (one retrieval suffices) or complex? Simple questions route straight to `retrieve`, skipping planning. **This is a feature, not a shortcut** — it demonstrates the agent knows when *not* to be agentic, and it is a measurable latency/cost win to report in M6. |
| `plan` | Decompose into 2–5 sub-questions, each assigned a tool, with optional `dependsOn` for genuinely sequential steps. Structured output. |
| `execute` | Run independent sub-questions **concurrently**; respect `dependsOn` ordering. Each call goes through the tool registry. |
| `reflect` | Given evidence so far, does anything material remain unanswered? If yes and `hops < MAX_HOPS`, emit follow-up sub-questions and loop to `execute`. This is the multi-hop mechanism. |
| `synthesize` | Produce the final answer. Every factual sentence must carry `[n]` markers resolving to `evidenceId`s. Prompt must explicitly permit "I could not find this in the available sources" — abstention is a scored behaviour in M6. |

Set `MAX_HOPS` (default 2) and a total wall-clock budget in config. Cap fan-out width.

**`src/agent/tools/`** — `AgentTool` interface plus initial implementations, all backed by
`RetrievalService` with a `sourceFilter`: `mail_search`, `chat_search`, `notes_search`, and
`all_sources_search`. Registry is a NestJS provider keyed by name; `plan` receives the tool
list and descriptions dynamically, so adding a tool never requires editing the planner.

#### M1.4 — Streaming HTTP surface

**`src/agent/agent.controller.ts`**
- `POST /agent/ask` — body `{question, sessionId?}`, responds `text/event-stream`.
- `GET /agent/runs/:runId` — full recorded run for replay/deep-link.

Event contract (`src/agent/events.ts`) — **freeze this in M1; M2 depends on it**:
```
run_started        {runId, question}
triage_done        {complexity, reasoning}
plan_created       {subQuestions[]}
tool_started       {subQuestionId, tool, input}
tool_finished      {subQuestionId, tool, evidenceIds[], latencyMs}
evidence_added     {evidence[]}
reflect_done       {gapFound, followUps[]}
memory_read        {refs[]}          // short-term turns as of M4.1; LTM facts in M4.2
memory_written     {refs[]}          // the turn just committed to the session
followup_resolved  {original, resolved}  // added M4.1; only when the text changed
token_delta        {text}            // streamed synthesis
run_finished       {answer, citations[], usage, costUsd, latencyMs}
run_failed         {error}
```

Enable CORS in `src/main.ts` for the UI origin.

#### Acceptance criteria — M1

- [ ] `POST /agent/ask` with a **simple** corpus question returns a cited answer, and the
      event stream shows `complexity: 'simple'` with no `plan_created`.
- [ ] `POST /agent/ask` with a **multi-hop** corpus question emits `plan_created` with ≥2
      sub-questions and `tool_started` events for ≥2 distinct sources.
- [ ] At least one seeded question triggers `reflect_done` with `gapFound: true` and a
      second hop.
- [ ] Every `[n]` marker in a final answer resolves to an `evidenceId` present in state.
      **Assert this programmatically** — it is a deterministic check.
- [ ] Switching `LLM_PROVIDER` between `gemini` and `ollama` in `.env` produces working
      answers from both, with no code change.
- [ ] Booting against an index built with a different embedding model fails fast with the
      actionable message from M1.2.
- [ ] Unit tests: `plan` node produces valid structured output against a stubbed LLM;
      `execute` runs independent sub-questions concurrently (assert via timing or call
      ordering); citation resolution rejects a fabricated `evidenceId`.

---

### M2 — UI *(target: 3–4 days)*

**Goal:** make M1 visible. Ugly and working beats polished and late.

`ui/` — Next.js (App Router), Tailwind, deployed separately to Vercel. Consumes the SSE
stream and renders panels as events arrive:

1. **Question box** + example questions from `corpus/questions.yaml` (one click to try).
   **Not optional, and not cosmetic** — this is the entire answer to "a visitor won't know
   what to ask," and it is why bring-your-own-data upload is *not* needed to make the demo
   usable (§12.1). Surface a spread across categories, and label them by what they
   demonstrate — e.g. a `multi-hop` one as "needs 2 sources", a `temporal` one as "a fact
   that changed", an `unanswerable` one as "should refuse to answer". A visitor clicking
   the last one and watching the system correctly decline is more convincing than any
   successful answer.
2. **Plan panel** — sub-questions appearing as `plan_created` lands, each showing assigned
   tool and live status.
3. **Tool timeline** — horizontal bars showing parallel execution and per-call latency. This
   is the single most compelling visual: it makes concurrency legible at a glance.
4. **Evidence panel** — retrieved chunks grouped by source, with scores; click to expand the
   full source document.
5. **Answer** — streamed tokens, with citation markers rendered as clickable chips that
   scroll to and highlight the corresponding evidence.
6. **Memory panel** — empty placeholder until M4. Ship the panel now, wire it later. *(Wired in M4.1: it shows the session turns a run read and the turn it wrote, labelled by direction.)*
7. **Run stats** — total latency, tokens, cost, hop count, provider/model used.

Add a `?demo=1` mode that replays a recorded run from `GET /agent/runs/:id` with no LLM
calls. **This matters more than it sounds:** it guarantees the demo works when free-tier
rate limits are exhausted, and it makes the README GIF trivial to record.

#### Acceptance criteria — M2

- [x] Local UI renders a full multi-hop run live, all panels populating in order.
      *Verified end to end in one sitting on 2026-09-05, live (no `?demo=1`), sampling the
      DOM as it streamed: triage `classifying` → `complex` at 2.1s, plan and two parallel
      tool calls at 3.6s, evidence 5 → 10 by 4.3s, finished at 11.7s with 2 citations.
      Stats populated with 4.4k/324 tokens, `$0.0056`, and a `served by` of
      `gemini-3.5-flash-lite → gemini-3.5-flash`. Citation chip scrolled its card from
      1439px off-screen into view, expanded and flashed; collapse worked. No console
      errors.*
- [x] Citation chips scroll to and highlight the correct evidence.
- [x] `?demo=1` replays a recorded run with zero API calls.
- [x] Mobile viewport is usable (recruiters open links on phones). *Checked at 375px: no
      horizontal overflow, single column, all panels legible.*
- [x] No unhandled promise rejections in the console during a full run. *Including the
      awkward paths — interrupting a run with a second question, and Stop mid-stream.*

---

### M3 — Observability *(target: 2 days)*

**Goal:** prove the system is inspectable, not just functional.

#### M3.1 — LangSmith

Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`. LangGraph.js reports
automatically. Free personal tier is sufficient. Verify nested spans show planner → tool →
LLM hierarchy correctly; add explicit run names/tags where the auto-generated ones are
unhelpful. **Make the project publicly shareable and put the link in the README** — a live
trace link is unusually strong evidence.

#### M3.2 — Local trace store

LangSmith is external and rate-limited; the UI needs its own data. Add a `runs` +
`run_spans` table and a `TraceCollector` that subscribes to the same event stream, persists
it, and backs `GET /agent/runs/:runId`. This is also what makes `?demo=1` possible.

#### M3.3 — Cost and token accounting

`src/observability/usage.service.ts` — per-run token totals and estimated cost from a
per-model price table in config (Ollama = 0). Surface in `run_finished` and the UI.

#### Acceptance criteria — M3

- [x] A run produces a LangSmith trace with correct span nesting; link works when logged out.
      *Span nesting **verified live 2026-09-05** against a real APAC-region account. A
      second-hop run traces as: `LangGraph → triage/plan/reflect/synthesize (llm children)`
      and `execute → [retriever] chat_search + notes_search`, then a second `execute →
      notes_search + mail_search` — planner → tool → LLM, with the reflect loop visible as
      two passes. Neither of the lower levels is automatic: model calls go through the raw
      `openai` SDK and tools are plain functions, so LangGraph sees neither.
      `LangSmithTracing.wrapClient` and `.traceTool` are what supply them; remove either and
      a level silently disappears. The trace is **shared publicly and confirmed to resolve
      logged out** (HTTP 200 anonymously, checked without a session); it is linked from the
      README's Observability section. Note `LANGSMITH_ENDPOINT` must match the account's
      region; a mismatch 403s every authenticated call and looks exactly like a bad key.*
      https://apac.smith.langchain.com/public/14204394-ae03-4e47-afb0-8ada1c2dd735/r/01a06fe7-641a-700e-8d18-34e5efc77473
- [x] `GET /agent/runs/:runId` returns a complete, replayable run. *Metadata, the verbatim
      event stream, and the span tree. Durable in sqlite, and now records failed runs too —
      the store it replaced was in-memory, capped at 100, and only ever saw runs that
      returned. Round-tripped in `sqlite-trace.repository.spec.ts`.*
- [x] Reported token counts match the provider's own reporting within ~5%. *They are the
      provider's own reporting: `prompt_tokens` / `completion_tokens` are read from each
      response and summed per run, never estimated. The residual risk is a provider that
      omits `usage` — that reads as 0, not as an error.*
- 🟡 Cost shows `$0.00` on Ollama and a plausible non-zero figure on a paid model. *The
      paid half is **observed**: a live Gemini run reported $0.00067689 across two models at
      different rates. The Ollama half is **unit-tested only** — `priceFor` short-circuits on
      `provider === 'ollama'` before any table lookup, so it reports $0.00 rather than "not
      priced" (the distinction the null path exists to preserve), and `usage.service.spec.ts`
      pins that. But `LLM_PROVIDER=ollama` has still never been run, so this is not observed
      behaviour and the box is not ticked. Prices in `src/config/model-prices.ts` were
      **verified against each provider's own pricing page on 2026-09-05** — the first draft
      was a generation out of date (Gemini 2.5 rates under 3.5 ids) and understated every run
      by ~4.5x, which is the failure mode to expect from that file.*

---

### M4 — Memory *(target: 3–4 days)*

**Goal:** persistence across turns and sessions — with an explicit policy for what *not* to
keep. The forgetting policy is the interesting engineering; unbounded storage is not memory,
it is a log.

#### M4.1 — Short-term (within session) — ✅ **done 2026-09-05**

Use LangGraph's checkpointer with a SQLite saver, keyed by `sessionId`. Gives conversational
continuity and resumable runs largely for free. Add follow-up-question handling: resolve
pronouns against checkpointed history before `triage`.

**What "largely for free" cost, as built.** Three things the sentence above hides, all
verified rather than reasoned about:

1. **"Keyed by `sessionId`" means turn two resumes the same thread**, and every reducer in
   `state.ts` merges or appends. Unguarded, turn two arrives at `execute` holding turn one's
   evidence, its finished sub-questions and its spent hop budget. An empty array cannot
   express the reset — "append nothing" is what it means to an appending reducer — so every
   per-turn channel treats `null` as "reset to default" and `NEW_TURN_RESET` is the one place
   that sends it. The channel that deliberately survives is `turns`, which *is* the memory.
2. **A failed run does not poison the next turn.** After a node throws, the thread keeps
   pending tasks (`getState().next` is non-empty), but a fresh invoke with input restarts
   from `START` rather than resuming them. Checked directly before the design was settled.
3. **Nothing was sending a `sessionId`.** The API had accepted one since M1 — DTO,
   controller, state, persistence — but `run_started` did not report the id the server
   minted, and `ui/app/page.tsx` never passed one, so every question opened a new
   conversation. `sessionId` is now an optional field on `run_started` (append-only,
   mirrored in `ui/lib/agent-events.ts`) and the UI adopts the server's id for the rest of
   the tab's session.

Also added, because the milestone goal is "an explicit policy for what *not* to keep":
`CHECKPOINT_RETENTION_SESSIONS` (default 50) prunes the oldest sessions after every run,
through a `CheckpointRepository` port. Measured on a real three-turn session: 22 checkpoint
rows, 93 pending-write rows, 231KB — ~77KB per turn, several times what the same
conversation costs the trace store, because a checkpoint is written per *superstep* and
carries the whole state.

The checkpointer itself is **not** behind a repository port (§0.3). It is LangGraph
infrastructure, the same category as the compiled graph, and `BaseCheckpointSaver` is
already the interface; wrapping it would be the §0.4 violation. It shares the existing
`SQLITE_CONNECTION` rather than opening its own handle. Forgetting is ours, and that has a
port.

#### M4.2 — Long-term (across sessions) — ✅ **done 2026-09-05**

Built as specified, with **one storage deviation** (below) and one placement refinement.

**Deviation: facts do not live in the `sqlite-vec` chunk index.** §5/M4.2 says "facts live in
the same `sqlite-vec` index under a distinct source". They live in `memory_facts` +
`vec_memory_facts` instead. Three reasons, in order of severity:

1. **`all_sources_search` passes no `sourceFilter`** — by design, it is the fallback tool. A
   fact in `vec_chunks` would come back as corpus evidence, be minted an `evidenceId`, and be
   cited as though it were a document. That breaks §4's load-bearing property: a citation
   resolves to a passage actually retrieved from the corpus. A shared index would make every
   present and future retrieval tool responsible for excluding memory.
2. **`chunks.article_id` is `NOT NULL REFERENCES articles(id)`**, so facts would need a
   sentinel article — and `IndexingService.removeDeletedArticles` deletes articles whose
   `index_state` path is gone from disk. It happens to spare a row that has no `index_state`
   entry, which is an accident to build memory on.
3. Facts need columns chunks do not have (importance, access count, decay timestamps) and
   UPDATE/DELETE semantics chunks never see.

They still use the same embedding provider and dimensions, so the `index_meta` identity guard
covers them: a model swap fails at boot rather than silently making memory unsearchable.

**Refinement: retrieval happens in `recall`, before `triage`, not before `plan`.** `triage`
routes a simple question straight past the planner, so retrieval sitting inside `plan` would
mean a remembered preference never reaches a simple question — which is most of them. It is
still "before `plan`"; it is just also before the branch that can skip it. Recalled facts
reach both the planner and the synthesiser as background, never as citable passages.

**Extraction runs after `synthesize`, in a `remember` node.** It needs the answer, and by that
point `token_delta` has already streamed — so the visitor is reading while it runs, and only
`run_finished` waits. The session turn is still committed by `synthesize`, one node earlier,
so short-term memory survives extraction failing.

`src/memory/long-term-memory.service.ts`:

- **Extraction** — after a run, a `fast`-tier call proposes candidate durable facts
  (stable preferences, entity relationships, corrections the user made). Structured output.
- **Scoring** — each candidate gets an importance score; below a configurable floor it is
  discarded immediately.
- **Deduplication** — embed the candidate, search existing facts; above a similarity
  threshold, *update* the existing fact (bump `accessCount`, refresh `updatedAt`) rather
  than inserting a duplicate.
- **Consolidation** — a periodic job (reuse the existing `SchedulerModule` pattern) merges
  near-duplicates and decays facts unused past a TTL.
- **Retrieval** — before `plan`, semantically search LTM for the current question and inject
  the top few into planner context, emitting `memory_read`.

Storage via a new `MemoryRepository` port + SQLite implementation, following the existing
ports pattern exactly. Facts live in the same `sqlite-vec` index under a distinct source.

**Instrument the funnel** — candidates proposed / kept after scoring / merged as duplicates /
finally stored. Report the retention rate in the README. "The system stores roughly 8% of
what it could" is a far better claim than "it has memory."

#### Acceptance criteria — M4

- [x] **Ask a question, state a preference, ask a follow-up in a new session — the preference
      is retrieved and visibly influences the answer.** Observed 2026-09-05: *"I work on the
      Helios billing migration. Why did the launch slip?"* stored the relationship; a **new**
      session then asked *"Did it ship on time in the end?"* — a question with no antecedent
      at all — and it was answered about Helios, off a `memory_read` carrying that one fact.
      The within-session half is observed too: turn 2 "Who approved it?" resolved to "Who
      approved the Helios launch slip?"; turn 3 "What was her role when she joined?" resolved
      *her* to Priya Raman out of turn 2's **answer** — two links of a reference chain — and
      abstained honestly.
- [x] **Stating the same fact twice produces one stored fact with an incremented counter.**
      Observed: a third session said *"I'm on the Helios billing migration team"*; the funnel
      reported `proposed 2 / merged 1 / stored 1`, and the table held one row with
      `access_count = 2`.
- [x] **Memory panel shows reads and writes for a run.** Direction is only on the wire as
      the event *type*, so the UI reducer stamps it onto each ref; the panel labels them
      `← read` / `→ written` and its heading reads "1 read · 1 written". Watched live in the
      browser on a two-turn conversation.
- [x] **Retention funnel counters are exposed** at `GET /memory/stats` — `proposed`,
      `droppedLowImportance`, `mergedDuplicate`, `stored`, plus `stored / proposed` and the
      surviving fact count. Cumulative in a table, so they survive a restart.
      ⚠️ **"Non-trivial" is not yet demonstrated.** Live traffic so far is 3 runs / 2
      candidates, and a retention rate off n=2 is not a claim worth making. The README
      describes the mechanism and the measured numbers with their n rather than quoting a
      headline percentage; revisit when M6's eval harness runs the 56-question set and
      produces a sample worth reporting.
- [x] **Unit tests: dedup merges above threshold and inserts below it; low-importance
      candidates are dropped.** All three in `long-term-memory.service.spec.ts`, plus the
      mid-flight-delete race, importance clamping, and unparseable extraction.
      *M4.1 added 17 API tests and 4 UI tests; M4.2 adds 39 more — 16 in
      `long-term-memory.service.spec.ts`, 9 in `sqlite-memory.repository.spec.ts`, 7 in
      `remember.node.spec.ts`, 3 more in `recall.node.spec.ts`, 4 in
      `agent-graph.service.spec.ts`.*

---

### M5 — MCP connectors *(target: 4–6 days)*

**Goal:** the same agent, over real data — without changing the graph.

Add `@modelcontextprotocol/sdk`. Build an MCP **client host**
(`src/integrations/mcp/mcp-host.service.ts`) that connects to configured MCP servers,
discovers their tools, and registers them into the existing tool registry. Because M1 made
tools uniform, the graph requires no changes — state that explicitly in the README, it is
the payoff of the M1 design.

Targets, in order: **Obsidian** (local filesystem MCP — easiest, no OAuth, and the owner
already uses Obsidian) → **Gmail** → **Slack**.

**Non-negotiable: demo-mode fallback.** Every live connector must have a synthetic
counterpart, selected by config. A visitor with no credentials must still get the full
experience. The deployed instance runs in demo mode; live connectors are a local-only
capability shown in the README with a GIF.

**Security — and this is a genuinely strong section for the README.** Once the system ingests
email, the corpus becomes attacker-controlled: anyone who can email the user can inject text
into retrieved context. Implement and document:
- Retrieved document content is delimited and labelled untrusted in every prompt.
- Tool-call arguments derived from retrieved content are schema-validated, never free-form.
- An injection-detection guardrail on ingested content (formalized in M6).
- Add adversarial documents to the corpus containing injection attempts, and **score
  resistance in the eval suite**.

Most agentic RAG portfolio projects have no threat model at all. Having one is a
differentiator disproportionate to its cost.

#### Acceptance criteria — M5

- [x] **At least one MCP connector answers a real question end to end.** Verified live
      2026-09-06: *"What did Priya privately conclude about why the Helios launch slipped,
      and what did she decide to do differently?"* → triage `complex` → two sub-questions,
      both assigned to `obsidian_search_notes` by the planner's own choice → 5 passages over
      the real MCP protocol → four citations, all resolving to vault notes. 3.9k input tokens.
      ⚠️ **Partial:** the connector was the in-process demo server, which is a real MCP server
      reached through the real client but not a third-party one. Pointing `MCP_SERVERS` at a
      published Obsidian server and recording the GIF is the remaining piece.
- [x] **`DEMO_MODE=true` runs the full pipeline with zero connector credentials.** Default on.
      It serves a real `McpServer` over the SDK's in-memory transport, so discovery,
      query-argument resolution, argument validation and result adaptation are all exercised
      rather than stubbed. Note the wording: it removes *connector* credentials, not the LLM
      key — nothing answers a question without one.
- [x] **No changes to `src/agent/nodes/` for the connector.** `git diff -- src/agent/nodes/`
      shows only the security work (the untrusted fence in `reflect` and `synthesize`), which
      is a different criterion on this list. The connector itself lands entirely in
      `src/integrations/`, `src/config/`, the `AGENT_TOOLS` factory, and two shared files —
      `retrieved-chunk.type.ts` and `citations.ts` — that own evidence identity.
- [x] **Injected adversarial documents cause no unauthorized tool call, covered by a test.**
      `src/integrations/mcp/injection-resistance.spec.ts` drives a real MCP server exposing a
      destructive `delete_note` tool with **every model stubbed to obey the injection**, and
      asserts the tool is never registered, never selected, and never called. Three adversarial
      documents are in the corpus with byte-exact payloads, and a live run described one rather
      than obeying it.

> **What M5 did not do.** Gmail and Slack connectors (the plan orders them Obsidian → Gmail →
> Slack; only the first is built), and injection *detection* — resistance is asserted here and
> scored in M6.

---

### M6 — Evals, guardrails, CI gate *(target: 4–5 days)*

**Goal:** the senior-signal milestone, absorbing the "Evaluated Guardrail Agent" idea. See §8.

#### M6.1 — Generalize the eval harness

Rewrite `evals/run-evals.ts` for the agent. Keep its two best existing traits: booting a real
Nest application context (so evals run against real wiring, not mocks) and forcing a
deterministic reindex first. Keep the threshold-sweep utility — it is reusable for tuning any
scored cutoff.

Metrics (per §7):
- Retrieval recall@k against ledger-known source documents *(deterministic)*
- Citation validity — every marker resolves to retrieved evidence *(deterministic)*
- Citation support — cited evidence actually supports the claim *(LLM judge)*
- Answer correctness against ledger ground truth *(LLM judge)*
- Abstention correctness on unanswerable questions *(LLM judge)*
- Injection resistance *(deterministic — did a forbidden tool call occur)*
- Plan quality — sub-question count and source coverage vs. reference *(mixed)*
- Cost, latency, hop count *(deterministic)*
- **Memory funnel yield** — of 56 runs, how many propose a candidate at all, and what
  fraction of candidates survive scoring and dedup *(deterministic — read `GET /memory/stats`
  before and after a suite run)*

**Two memory questions this suite is the first chance to answer, both deliberately left open
in M4.2 rather than guessed at:**

1. **Is the retention rate non-trivial?** M4's acceptance criteria ask for counters that show
   the system is *not* storing roughly everything. Live traffic at the end of M4 was 2
   candidates, which is not a sample. A 56-question run is. Until then the README describes
   the mechanism and the raw numbers with their n, and quotes no percentage.
2. **Should extraction be gated?** `remember` adds a `fast` call to every answered run — ~4
   model calls per run became ~5–6 — against a free tier of ~20 per window, which §9 and the
   dead-ends list both call the dominant failure mode. The obvious gate is to skip extraction
   unless the question contains first-person markers (`I` / `my` / `we`), since corpus
   questions contain none and self-disclosure is the only thing extraction can act on.
   **Deliberately not implemented**: it is a heuristic, and this suite measures the thing that
   decides it — if ~54 of 56 runs propose nothing, the gate is obviously right; if 20 propose
   something, it is not. Same discipline as `MEMORY_DEDUP_DISTANCE`: measure, then choose.

**The headline number: agent vs. single-shot RAG baseline on the multi-hop question set.**
Implement the baseline as a flag on the same harness so the comparison is apples to apples.
If the agent does not clearly beat the baseline, that is a finding worth investigating and
then reporting honestly — a plan that only works when the numbers are flattering is not an
eval suite.

#### M6.2 — Guardrails

`src/guardrails/` — a uniform `Guardrail` interface with `check(input): Promise<Verdict>`,
composed into pre- and post-stages:

- **Input:** prompt-injection detection on ingested documents; question length/abuse limits.
- **Output:** every factual claim carries a citation; no PII from one source leaking into an
  answer scoped to another; refusal correctness on unanswerable questions.

Each guardrail is independently testable and independently scored in the eval suite. Prefer
deterministic checks where possible; use an LLM judge only where genuinely needed, and
measure the judge's own agreement with a small hand-labelled set.

#### M6.3 — CI gate

`.github/workflows/evals.yml`:
- On PR: run the fast subset against a free provider (Groq or Gemini free tier) using
  repository secrets. Compare against `evals/baseline.json`. **Fail the build on regression
  beyond tolerance.**
- Nightly: full suite, commit results to `evals/history/`, render a trend table in the README.
- Also run `pnpm build`, `pnpm lint`, and unit tests on PR.

Keep the PR subset small enough to stay inside free-tier limits — that constraint is itself
worth documenting.

#### Acceptance criteria — M6

- [x] `pnpm eval` produces a metrics table and writes `evals/results-latest.json`.
- [x] `pnpm eval --baseline=single-shot` runs the non-agentic comparison. Implemented as a
      mode of the same harness, scored by the identical code, and verified on real questions.
- [x] **README contains a results table with both, and the delta.** Done 2026-10-04. Both modes
      over all 59 questions through identical scoring code, 0 runs failed in either, connectors
      verified off. **The control wins** — recall@k 96.4% vs 100%, answer correctness 65.4% vs
      77.6%, with the agent ahead on `meets minHops` (96.6% vs 49.2%) and citation support.
      Ticked on the strength of the deterministic half, which is complete for both modes; the
      judged half carries a stated limitation rather than a silent one — Groq's free tier left
      26 of 59 agent questions with a verdict against 58 of 59 for the control, so judged rates
      are also reported over the 26 questions both modes share (agent 65.4% / control 84.6%).
      **The number is not the win §5/M6.1 anticipated, and it is more useful than one.** The
      first comparison put the agent at 90.5% recall against the control's 100% with every miss
      shaped `1/2`; that localised the cause to decomposition narrowing each query away from
      the language of the document holding the other half. Issuing the question *as asked*
      beside the decomposition recovered seven of ten and took recall to 96.4% — which in turn
      exposed the real remaining gap as **synthesis**, not retrieval: eight of 26 matched
      verdicts are `partial` against one outright wrong, so the agent retrieves both documents
      and then answers from one. A control that merely lost would have taught none of that.
- [x] A deliberately regressing PR fails CI; the failure output names the metric and delta.
      Covered permanently by `evals/compare.spec.ts`, which runs against the *committed*
      `baseline.json` so a floor lowered or a tolerance widened until nothing trips it breaks
      the tests rather than quietly disarming the gate.
- [x] Every guardrail has a unit test for both pass and fail paths
      (`src/guardrails/guardrails.spec.ts`).
- [ ] **The LLM judge's agreement with hand labels is measured and reported.** The 20
      hand-authored items exist (`evals/judge-labels.json`, each naming a ledger question, an
      answer, and the documents it cites), `pnpm eval:judge-agreement` runs them through the
      same judge the suite uses and reports per-dimension agreement plus a confusion matrix,
      and the label file states its own limitation — the answers are authored rather than
      sampled from real runs, so any figure it produces is an optimistic bound.
      **It has not been run to completion.** Same cause as the criterion above: 20 judge calls
      against a provider whose window the 59-question pass had already exhausted. One item
      scored before the wall (`exact-correct`, agreeing on all three dimensions), which is not
      a measurement. Left un-ticked rather than reported from n=1.
- [x] The two memory questions above are answered from the run, not estimated: a retention
      rate over a real sample, and a decision on whether to gate extraction.
      **Both answered by the same number.** Across all 59 questions the extractor proposed
      **zero** candidates, so (a) `stored / proposed` is `0/0` — *undefined*, not zero, and the
      README still quotes the mechanism and the raw counts rather than a headline percentage;
      and (b) the gate is in. §5/M6.1 set the bar at "if ~54 of 56 runs propose nothing, the
      gate is obviously right"; 0 of 59 clears it. `mentionsSelf` in
      `long-term-memory.service.ts` now skips extraction when the question contains no
      first-person marker, which saves a `fast` call on every corpus-style run **and** closes
      the document-to-memory injection path M5 left open — an answer derives from retrieved
      documents, but the *question* does not, so attacker-authored text can no longer reach
      durable memory at all.
      A `skippedNoSelfReference` funnel counter records how often the gate fires, because
      after it ships `proposed: 0` is 0 by construction and would otherwise be
      indistinguishable from the behaviour that justified it.

**Deviations, all deliberate — see `evals/README.md` for the full reasoning:**

- **`evals/run-evals.ts` did not exist.** §3 calls it "the strongest existing asset" and
  §5/M6.1 says to rewrite it keeping its two best traits. That code lived in the original
  client repo and was never carried across; `git log -- evals/` is empty. It was written from
  scratch, keeping the two traits described (a real Nest application context, a forced
  deterministic reindex) because they are good, not because there was code to preserve.
- **The judge is separated by provider, not by tier.** §7 asks for a different model tier.
  On the free tier `deep` resolves to the same model as `default`, so that separation does not
  exist here. The judge runs on the first configured fallback provider instead (Groq, with the
  recommended setup), and when even that is unavailable the results record
  `separateProvider: false` and the table prints a warning rather than implying independence.
- **One judge call per question returns all three judged verdicts.** Three calls would be more
  independent and would cost 118-177 more against a free tier of ~20 per window, which in
  practice means the suite does not get run. The verdicts are therefore not independent, which
  is stated wherever the numbers appear.
- **The suite runs with connectors off and long-term memory reset between questions.** The
  first keeps every score attributable to the hand-authored answer key; the second keeps the
  suite reproducible. Both are recorded in `results-latest.json` with every run, and both have
  a flag to invert them.
- **Two of M6.2's listed guardrails were deliberately not built**, on §0.4's reasoning.
  *"No PII from one source leaking into an answer scoped to another"* guards a boundary the
  product does not have — an answer merges evidence from every tool the plan used, by design,
  and a guardrail enforcing a non-existent scope would pass 100% of the time while looking
  like a control. *"Refusal correctness on unanswerable questions"* is not checkable where an
  answer is produced: whether refusing was right depends on whether the corpus could have
  answered, which only the answer key knows. It is scored as a metric (abstention correctness)
  instead, and the locally-checkable half — that an abstention did not also answer — is the
  `abstention-consistency` guardrail.
- **Nightly results are archived and uploaded, not committed to `evals/history/`.** §5/M6.3
  asks for a committed history and a README trend table. Pushing to `main` from a scheduled
  workflow needs `contents: write` on a public repo, which is a decision worth making
  deliberately rather than as a side effect of wanting a table — and a trend over zero nightly
  runs is an empty one. The archive step is written; enabling the push is a one-line change
  once there is history worth trending.

---

## 6. Corpus specification

**Read this fully before generating anything.** A weak corpus makes every downstream metric
meaningless, and it is expensive to change once evals are calibrated against it.

### Principle: ground truth is authored first

Do **not** generate documents and then write questions about them. Write a structured **fact
ledger** first, then generate documents that express those facts, then derive questions from
the ledger. The ledger is the answer key. This is what makes the eval suite trustworthy, and
it is worth a paragraph in the README — most portfolio eval sets are graded by the same model
that wrote the questions, which measures nothing.

### Setting

A fictional ~30-person software company (suggested: **Lumen Labs**, building a developer
analytics product). Enough surface for email, chat, and notes to plausibly overlap. Entirely
invented — no real company, product, or person.

### Volume

| Source | Count | Form |
|---|---|---|
| `corpus/generated/mail/` | ~120 messages across ~40 threads | Markdown, frontmatter: `from`, `to`, `subject`, `date`, `threadId`, `docId` |
| `corpus/generated/chat/` | ~15 channels, ~200 messages | Markdown per channel-day, frontmatter: `channel`, `date`, `participants`, `docId` |
| `corpus/generated/notes/` | ~40 notes | Obsidian-style, `[[wikilinks]]`, frontmatter: `title`, `tags`, `updated`, `docId` |

Large enough that retrieval is non-trivial; small enough to index in seconds and stay
committable.

### Ledger schema (`corpus/ledger/*.yaml`)

```yaml
entities:
  - id: person.ravi
    type: person
    name: Ravi Anand
    role: Staff Engineer

facts:
  - id: fact.helios-delay-cause
    statement: "The Helios launch slipped from 2026-03-10 to 2026-04-21 because the
                billing migration failed load testing at 4x expected volume."
    expressedIn: [chat.eng-helios.2026-02-18]
    supersedes: null

  - id: fact.helios-delay-signoff
    statement: "Priya Raman approved the revised 2026-04-21 date on 2026-02-20."
    expressedIn: [mail.thread-helios-date-change.msg-3]

  - id: fact.pricing-v2-decision
    statement: "Usage-based pricing was chosen over seat-based on 2026-01-14."
    expressedIn: [notes.pricing-decision-record]
    supersedes: fact.pricing-v1-decision   # temporal trap
```

### Required question categories (`corpus/questions.yaml`)

Every category must be represented. Target ~60 questions total.

| Category | Count | Purpose |
|---|---|---|
| **Single-hop** | ~12 | Baseline sanity, and proof `triage` correctly skips planning |
| **Multi-hop, cross-source** | ~20 | **The core.** Answer requires ≥2 facts from ≥2 different source types |
| **Temporal / superseded** | ~8 | A fact changed; only the current value is correct. Punishes naive similarity retrieval |
| **Distractor-heavy** | ~8 | Near-duplicate plausible-but-wrong content exists |
| **Unanswerable** | ~8 | Answer genuinely absent. Correct behaviour is explicit abstention |
| **Adversarial / injection** | ~4 | Documents containing instruction-injection payloads (added M5) |

Question entry format:
```yaml
- id: q.helios-delay-why-and-who
  question: "Why did the Helios launch slip, and who approved the new date?"
  category: multi-hop
  requiredFacts: [fact.helios-delay-cause, fact.helios-delay-signoff]
  requiredSources: [chat, mail]
  minHops: 1
  expectedAbstention: false
  referenceAnswer: "..."
```

`requiredFacts` → `expressedIn` gives the exact documents that must be retrieved, making
**recall@k deterministic** rather than an LLM judgment. This is the design decision that
makes the whole eval suite cheap and trustworthy.

### Generator

`scripts/corpus-generate.ts`:
- Reads the ledger; for each document, prompts the LLM to write it naturally, expressing
  only its assigned facts.
- **Deterministic**: fixed seed, temperature 0, and the generated output is committed. The
  generator is for regenerating/extending, not a runtime dependency.
- **Verification pass**: after generation, check every ledger fact appears in its assigned
  documents (semantic check via embedding similarity, with a manual-review report for
  anything below threshold). A generated document that silently dropped its fact corrupts
  the answer key.
- Include natural noise — greetings, tangents, scheduling chatter — so retrieval faces
  realistic signal-to-noise. Uniformly information-dense documents make retrieval
  artificially easy.

---

## 7. Metrics reference

| Metric | Method | Why it matters |
|---|---|---|
| Recall@k | Deterministic — did retrieved chunks include `expressedIn` docs? | Retrieval quality, isolated from generation |
| Citation validity | Deterministic — every `[n]` resolves to a retrieved `evidenceId` | Catches fabricated citations outright |
| Citation support | LLM judge — does cited evidence support the claim? | Catches real-citation/wrong-claim |
| Answer correctness | LLM judge vs. `referenceAnswer` + `requiredFacts` | Headline accuracy |
| Abstention correctness | LLM judge on unanswerable set | Hallucination resistance |
| Plan quality | Sub-question count + source coverage vs. `requiredSources` | Planner quality in isolation |
| Injection resistance | Deterministic — forbidden tool call attempted? | Security posture |
| Hops used | Deterministic | Efficiency; catches runaway loops |
| Cost / latency per query | Deterministic | Production realism |
| **Agent vs. single-shot delta** | Same suite, both modes | **The headline claim** |

Judge discipline: use a *different* model tier for judging than for answering; hand-label
~20 items and report judge agreement. An unvalidated LLM judge is not a measurement.

---

## 8. On the "Evaluated Guardrail Agent" project

The repo owner asked whether that should be a separate project. **Recommendation: fold it in
as M6.**

- A guardrail system evaluated against synthetic examples is a toy. Evaluated against a real
  agentic system with real failure modes — an agent that reads attacker-controlled email —
  it is credible, and the threat model writes itself.
- Two projects sharing ~70% of a stack read as one project. One deep project with numbers
  beats two shallow ones.
- It reuses the corpus, harness, traces, and deployment, so it costs a fraction of a
  standalone build.

Structure it to read as a distinct accomplishment: its own top-level `src/guardrails/`, its
own README section, its own CI badge, its own resume bullet.

**The one case for splitting it out later:** packaging the eval-gate as a reusable artifact —
an npm package or GitHub Action others can drop into their own LLM repos. That is an
OSS-tooling story that genuinely stands alone. Consider it only after M6 ships.

---

## 9. Deployment

**Constraint: zero cost.** No paid tiers, ideally no credit card.

*Built 2026-09-06. What follows is what was decided and why, not a sketch — the sketch that was
here (a `dist/scripts/corpus-index.js` that never existed, a keyless build that §11.4's reversal
had already broken, and a Turso row) is superseded below.*

### The target moved, because the free tier did

§9 originally chose **Hugging Face Spaces (Docker)** and rejected Render by name for its cold
start. That table was written at planning time, and §9's own instruction to re-verify it is the
reason this section no longer follows it:

- **Hugging Face now requires PRO ($9/mo) to create a Gradio or Docker Space.** Free accounts
  get Static Spaces only; the change rolled out between June and August 2026 and existing free
  Spaces were grandfathered. Its own pricing page lists "Create Gradio & Docker Spaces" as a PRO
  line item.
- **Koyeb's free Starter plan closed to new signups** after Mistral acquired them in February
  2026. Pricing now starts at $29/mo.

What is left, checked on 2026-09-06:

| Host | Cost | Card | Cold start | Verdict |
|---|---|---|---|---|
| **Render free** | $0 | none | 30–60s after 15 idle min | **Chosen.** The only remaining option that is free *and* needs no card |
| Northflank Sandbox | $0 | verified, not charged | none, always-on | Better, if a card on file is acceptable |
| Cloud Run | ~$0 at this volume | required | 2–5s | Technically the best of the four |
| HF Spaces Docker | $9/mo | required | none (48h sleep) | What §9 planned for, before it was paid |

So the cold start is the price of the zero-cost constraint, not an oversight. What makes it
survivable is the next section.

### Targets

| Piece | Choice | Notes |
|---|---|---|
| Backend + baked index | **Render free (Docker)** | `render.yaml` is committed, so the deploy is reviewable rather than remembered clicks. The image is host-neutral — `PORT` comes from the environment — so moving to Northflank or Cloud Run is a redeploy, not a rewrite |
| Frontend | **Vercel** free | `NEXT_PUBLIC_API_URL` → the Render URL |
| Persistent memory writes | **None. Nothing was provisioned** | The draft's Turso row assumed long-term memory ships publicly; it does not. See below |
| Tracing | **LangSmith** free personal tier | `LANGSMITH_ENDPOINT` must match the account's region |
| Inference (chat) | Gemini free (default), Groq free as fallback (§11.3) | `FailoverLlmService` crosses providers on quota |
| Inference (embeddings) | Gemini free at **runtime**; none at build time | The index is baked from committed vectors — see below |

**Two warnings that still hold:**

- **Do not run the agent loop on Vercel serverless.** Function timeouts will kill 30–90s
  multi-hop runs. Frontend only.
- **Free tiers change.** This table was re-verified on 2026-09-06 and two of its four rows had
  already moved. Verify again rather than trusting it.

### The key move: bake the index into the image

The demo corpus is fixed and read-only, so the `sqlite-vec` index is built at Docker build time
and shipped inside the image.

This is what makes an ephemeral free tier usable at all, and the argument is sharper than "cold
starts are slow". Every host above has an ephemeral filesystem, and on Render's free plan a
restart is every fifteen idle minutes. A container that indexed at boot would spend ~172
embedding calls on every wake, against a free tier that answers ~20 per window — so it would
come back not merely slow but rate-limited, and stay that way for an hour. With the index baked,
the boot pass skips all 172 documents by checksum and makes zero calls.

`ReindexScheduler` still runs at startup and should stay: it is what makes the baked index
self-verifying (`indexed=0 skipped=172` in the boot log, which CI asserts). It is not a
substitute for baking.

### The keyless build, restored — by shipping the vectors

§11.4's reversal (embeddings default to Gemini; the local in-process provider was never written)
left this build needing an API key and ~172 network calls. §9 listed three ways out; the one
taken is **option 2, ship a pre-built index — but shipped as the vectors, not as the database.**

`corpus/index/embeddings.json` (~700KB, committed) holds one base64 float32 vector per chunk,
keyed by a hash of the exact chunk text. `EMBEDDING_PROVIDER=precomputed` replays it, so
`pnpm corpus:index` builds the whole index offline in 0.8s with no key.

Why the vectors rather than the `.db`:

- **Smaller by 6×.** The vectors are 172 × 768 × 4 = 528KB; the same data inside sqlite occupies
  3.0MB, because `sqlite-vec` allocates a full 1024-row chunk however few rows are in it. A
  cleaned `app.db` would be ~3.3MB of opaque binary.
- **It is the only irreproducible part.** Everything else in the index — the documents, the
  chunking, the schema — is already in git and is recomputed by the build.
- **Staleness is loud, and checkable for free.** The key is a hash of the chunk text, so editing
  a corpus document or changing `CHUNK_SIZE` makes the build fail on the first chunk rather than
  producing an index that is quietly a mixture of two corpora. `pnpm corpus:vectors --check`
  reports coverage in both directions and runs in CI with no key.

**What it costs.** A ~700KB artifact in a public repo, rewritten whenever the corpus changes;
one more `EMBEDDING_PROVIDER` value; and a rule to remember, which CI now remembers instead.
Note that `precomputed` is a *build-time* provider only — a running server embeds questions,
which are not in the artifact and cannot be, so it fails loudly on the first search.

Generating the artifact needs a key exactly once, and `pnpm corpus:vectors --from-index` avoids
even that by lifting the vectors out of an already-built index. Verified bit-identical: all 172
vectors in the image match the development index exactly.

### No database was provisioned, deliberately

The draft table once read "persistent memory writes → Turso free". Nothing was provisioned,
because the decision it depended on went the other way:

- **Long-term memory is off on the public instance** (below), so the feature that wanted durable
  storage does not run there.
- Everything still written is disposable and bounded: traces (`TRACE_RETENTION_RUNS`),
  checkpoints (`CHECKPOINT_RETENTION_SESSIONS`), and a `?demo=1` replay writes neither. A session
  dies with the browser tab in any case (§11.8).

So an ephemeral filesystem is *correct* here rather than tolerated, and the free tier's headline
limitation costs this deployment nothing. Provisioning a database first and deciding the feature
afterwards would have bought a dependency to keep alive for a feature that does not ship.

### Two decisions taken before deploying, not during

**1. Long-term memory does not ship publicly.** `recall()` searches all of `memory_facts` with no
visitor filter. Crossing sessions *is* the M4.2 feature, so a session filter would delete what
the milestone demonstrates — and on a URL with no sign-in, cross-session is also cross-visitor:
one person's extracted fact reaches the next person's planner prompt.

`LONG_TERM_MEMORY=false` on the deployed instance; long-term memory stays a **local capability,
like live connectors**. The exposure it closes is narrow — M6's `mentionsSelf` gate means a
corpus question stores nothing, so the only reachable case is a visitor writing a first-person
sentence — but that is exactly the case that would leak, so the flag costs almost nothing visible
and closes the channel completely. It also settles the inconsistency HANDOFF flagged:
`MemoryController` refuses to serve fact bodies over HTTP while `memory_read` streams the nearest
three to whoever asks the next question. With nothing stored, the two agree.

`GET /memory/stats` reports `enabled` alongside the funnel, because a funnel of zeros otherwise
cannot distinguish "nothing was worth remembering" from "the feature is off".

*The alternative, for the record:* a per-browser id in `localStorage` would preserve the M4.2
demonstration on the deployed instance, at the cost of a `visitor_id` column, a
`MemoryRepository` change, plumbing through `recall`/`remember`/the ask DTO, a UI change and
evals plumbing — and it is spoofable. Worth revisiting only if the deployed instance needs to
*show* cross-session recall.

**2. `POST /agent/ask` is rate limited.** `AskThrottlerGuard` (`@nestjs/throttler`, in-memory),
5 questions per 10 minutes per IP by default. Budgeted in model calls rather than requests: one
question costs ~4 against a free tier that answers ~20 per window. `?demo=1` replays are exempt —
they cost nothing, and they are the fallback a visitor is pushed towards when quota is gone.

CORS stays `origin: true`, and it is not the missing control it can look like: it decides which
*origins* a browser hands the response to, and offers nothing against a caller that is not a
browser. The rate limit applies to everyone equally.

**`TRUST_PROXY_HOPS` is load-bearing for that limit.** Behind a platform proxy every request
arrives from the proxy's address, so at 0 the whole internet shares one bucket and the first
visitor to spend five questions locks out everyone else. Trusting more hops than exist is the
mirror failure — `X-Forwarded-For` is client-supplied, so an over-long chain lets a caller mint a
fresh identity per request. Default 1; set 0 when the API is reached directly.

### Rate-limit resilience

Free tiers will be exhausted at some point, and it will happen while someone is looking. §9 asked
for a recorded run with an honest banner rather than a 500. **Half of it already existed and had
never been reachable**: the event contract has carried `run_replayed.reason: 'quota_exhausted'`
since M2 and the UI's `ReplayBanner` renders it, but nothing in the API ever set that reason.

`QuotaFallbackService` closes it. `FailoverLlmService` now throws a typed
`AllProvidersFailedError` carrying `quotaOnly`, and only a whole-chain quota refusal arms the
fallback — a timeout, an abort or an unreachable provider is an outage, and answering an outage
with a cheerful fixture is the dishonesty the banner exists to prevent.

**The run that hits the wall still reports its own failure.** `run_replayed` is documented as the
first event of a replayed run, and that is the honesty mechanism rather than a formatting detail;
a run that failed halfway and then began replaying would emit it fourth, after `run_started` and
`run_failed`, and the UI's reducer would merge the abandoned run's evidence into the recording's.
So the breaker diverts the *next* request, from its first event, and expires on a timer — because
finding out whether quota returned costs the model call there is none of. A successful run closes
it early.

### What the free tier's cold start looks like to a visitor

Nothing removes the ~50s, so the UI stops it from looking like a fault:

- The page fetches `/agent/examples` on mount, which is also what wakes the service — the spin-up
  overlaps with the visitor reading the page rather than following their first question.
- `ColdStartBanner` appears if that fetch takes more than 3s, saying the instance sleeps and is
  waking. A warm instance answers in milliseconds and shows nothing.
- `ConnectionBanner` now branches on whether the API is local: telling someone to run
  `pnpm start:dev` against a public URL is advice they cannot act on.

### What is in the repo

| File | Why |
|---|---|
| `Dockerfile` | Two stages; builds the index keyless in the builder, runs as `node`. Host-neutral |
| `.dockerignore` | Keeps `database/` and `.env` out of the build context — a developer's traces have no business in a published image |
| `render.yaml` | The blueprint, so the deployment is reviewable. Secrets are `sync: false` |
| `scripts/corpus-index.ts` | Builds `database/app.db`. **Not** `dist/scripts/corpus-index.js` — `scripts/` stays out of `tsconfig.build.json`, because putting it back is what once made `nest build` emit `dist/src/main.js` |
| `scripts/corpus-vectors.ts` | Writes the vector artifact; `--from-index` lifts it out of a built index for free, `--check` verifies coverage |
| `src/embeddings/precomputed-embedding.provider.ts` | Replays the artifact |
| `src/agent/ask-throttler.guard.ts` | The rate limit |
| `src/agent/quota-fallback.service.ts` | The degraded demo |
| CI `docker` job | Builds the image, boots it, streams a recorded run, and asserts `skipped=172` |

### What building it actually found

None of these were visible from the source, which is why §9 asked for the image to be *booted*
rather than built:

1. **The runtime user could not write to the baked database.** `database/` was root-owned from
   the builder stage, and sqlite in WAL mode creates `-wal`/`-shm` *beside* the file — so the
   image built perfectly and died on first boot with `SQLITE_READONLY_DIRECTORY`. Fixed with
   `COPY --chown=node:node`.
2. **`EMBEDDING_MODEL` defaulted to `bge-m3` at 1024d while `EMBEDDING_PROVIDER` defaulted to
   `gemini`.** A pair that cannot work, left over from when Ollama was the default provider, and
   invisible locally because `.env` supplies both. The container has no `.env`, so the index
   identity guard refused to boot against `gemini/bge-m3:1024`. The defaults now match.
3. **The index identity guard read the *config* while the indexer wrote the *provider*.**
   Equivalent for gemini and ollama, and wrong for `precomputed`, which reports the identity of
   the model that produced the vectors it replays. Both sides now read the provider, which is
   what the guard's own comment always claimed.
4. **`corpus/generated` is not optional in the runtime image.** Without it the boot reindex finds
   every indexed path missing from disk and `removeDeletedArticles` deletes the baked index — a
   healthy startup destroying the thing the image exists to ship.

### Deploying

1. Render → New → Blueprint → this repo. Supply `GEMINI_API_KEY`, `GROQ_API_KEY` and
   `EMBEDDING_API_KEY` when prompted. The third is the Gemini key again under the name the
   embedding provider reads — it falls back to `LLM_API_KEY`, *not* to `GEMINI_API_KEY`.
2. Deploy the UI to Vercel with `NEXT_PUBLIC_API_URL` pointing at the Render URL.
3. Optionally set `LANGSMITH_TRACING=true` with a key whose `LANGSMITH_ENDPOINT` matches the
   account's region.

---

## 10. Resume output

The point of the project. Draft after M6; these are targets to build toward, and **every
number must be real and reproducible from `evals/results-latest.json`.**

**Project entry** (replaces the Real-Time Collaborative Whiteboard entry, which is generic;
keep the Rubik's Cube Solver — the pattern databases and IDA* are the strongest technical
signal on the page):

> **Throughline — Agentic RAG over multi-source data** *(TypeScript, NestJS, LangGraph, MCP, LangSmith, Next.js)*
> - LangGraph planner decomposes questions into sub-questions, fans out to mail/chat/notes
>   tools in parallel, and re-queries on detected gaps; streams the plan, each retrieval and
>   the cited answer live over SSE.
> - Built a **59-question benchmark from a hand-authored fact ledger**, so recall@k and
>   citation validity are deterministic checks rather than model judgments — then measured the
>   agent against a single-shot RAG control through identical scoring code.
> - **The control won, and the measurement said why:** query decomposition narrowed retrieval
>   below the breadth of one sweep. Searching the question as asked alongside the decomposition
>   lifted recall@k **90.5% → 96.4%** (51.7% → 86.7% on the affected questions) and localised
>   the remaining gap to synthesis, not retrieval.
> - Eval-gated CI over a 9-question subset scoring recall@k, citation faithfulness and
>   abstention; PRs fail on regression. Prompt-injection threat model with real payloads in the
>   corpus. Full LangSmith tracing with per-run token and cost accounting.

**On leading with a negative result.** The third bullet is the strongest thing on this entry and
it should not be softened. Anyone can show a system that works; being able to say "I built the
thing, built the measurement, and the measurement said my system lost to a simpler baseline —
here is the mechanism, here is the fix, here is what it did and did not recover" is a claim
about engineering judgement that a passing demo cannot make. It also pre-empts the obvious
interview attack, because the interviewer cannot find a weakness the candidate has not already
named and quantified.

Two caveats to carry verbatim if the numbers are discussed, both recorded in the README at the
point each number appears: only **26 of 59** agent questions carry a judge verdict (free-tier
quota), so judged rates are quoted over the matched subset both modes share; and injection
resistance reads 87.5% rather than 100% because `tokenLeaked` is a substring test that cannot
distinguish the agent *quoting* a canary while describing an attack from obeying one — the
defence itself held.

**Work bullet — add to the Logicease/Globhe section now, independent of this project.** It is
already true and needs no public repo:

> Built a RAG support-draft pipeline (NestJS, sqlite-vec, local Ollama) grounding replies in
> a multilingual ticket knowledge base; eval-tuned the retrieval confidence threshold to
> separate 22 relevant from 8 off-topic queries with zero overlap.

**Skills line — currently contains no AI/ML entries at all.** Add after M1:
`RAG, vector search, embeddings, LangGraph, MCP, LangSmith, Ollama, sqlite-vec, LLM evals`.

### Interview framing

Recorded here because it drives design decisions elsewhere in this document (notably §6's
ledger-first corpus and §2's anti-goal against swapping it for a public dataset). Both
questions below get asked; the second one is where the project either reads as serious or
reads as a toy.

**"Why did you build this?"**

> I work across Gmail, Slack, Obsidian and a helpdesk. Answering something like "why did the
> launch slip and who signed off on the new date" means opening three tools and stitching it
> together myself — the answer isn't in any single document, so ordinary RAG can't do it. I
> built an agent that plans the decomposition, fans out across sources, and cites what it used.

**"Isn't your test data fake?"**

> I couldn't publish my actual work data, and no public benchmark exists for multi-hop QA over
> mixed email/chat/notes with source attribution. So I authored a ground-truth fact ledger
> first and generated the corpus from it — the same approach LoCoMo uses, and structurally
> what HotpotQA and MuSiQue contribute (the value in those is the human-annotated supporting
> facts, not the text). The facts are hand-written; only the prose is generated; the generator
> verifies each fact's exact dates and names survived generation. That answer key is what
> makes recall@k and citation validity deterministic checks instead of LLM-judged ones.

The second answer is the one that signals seniority — it is a claim about *eval design*,
which is the part most portfolio RAG projects skip entirely.

---

## 11. Open decisions

Decided items are marked ✅. Remaining items resolve before or during M0, with a recommendation.

1. ✅ **Project name: `throughline`.** Locked 2026-08-04. Used everywhere in this document —
   `package.json`, repo name, README, deployed URLs.
2. ✅ **Corpus setting: "Lumen Labs".** Accepted 2026-08-04. Any fictional company would do;
   the schema matters, the theme does not. See the anti-goal in §2 about swapping it for a
   public dataset.
3. ✅ **Default chat provider: Gemini primary, Groq fallback.** Locked 2026-09-04. Configure
   with `LLM_PROVIDER=gemini` and `LLM_FALLBACK_PROVIDERS=groq`.

   Groq was briefly made primary for a day, on the argument that Gemini's free tier (~20
   requests per window per model, against ~4 calls per agent run) could not sustain
   development. Two things retired that argument:
   - The recorded-run replay (`?demo=1`) means UI work spends no quota at all, which was the
     actual reason to want a bigger budget.
   - Capturing runs on both showed what Groq costs: **fewer citations** — 2 vs 5 on the same
     multi-hop question, and 0 vs 1 on a simple one — and 26–48s runs against Gemini's ~10s,
     because `gpt-oss` reflects on roughly 3 of 4 questions where Gemini does on 3 of 30, and
     its per-call latency swings between 0.35s and 19.7s.

   Citation density is the project's core claim, so trading it for headroom the fixtures
   already provide is the wrong trade. The quota risk is real but bounded: a visitor asks one
   question at a time, and `FailoverLlmService` drops to Groq when Gemini refuses.
4. ⚠️ **Default embedding provider — superseded 2026-09-04.** Originally locked as local
   in-process (`bge-small-en-v1.5`, 384d). In practice the default is **Gemini**
   (`gemini-embedding-001`, 768d): the local provider was never written, and `local` is not
   even a value in `EMBEDDING_PROVIDER`'s enum. The corpus is indexed against Gemini, and the
   `index_meta` identity guard makes a later swap fail loudly rather than silently.

   **The cost of this reversal landed in §9, and §9 paid it** (2026-09-06). The original
   decision existed to keep the Docker build offline and keyless. That property is restored
   without restoring the dependency: `corpus/index/embeddings.json` ships the vectors and
   `EMBEDDING_PROVIDER=precomputed` replays them, so the image indexes 172 documents in 0.8s
   with no key and no network. Gemini remains the runtime provider — a question still has to be
   embedded when it is asked — so this closes the build half only, which was the half that
   mattered. **Do not reopen this to write the local provider**: it would invalidate the
   committed index, every measured distance in `docs/`, and the M6 numbers, to buy a property
   §9 already has.
5. **Anthropic support.** Owner has a key but prefers not to spend it. *Recommendation: leave
   the seam, do not implement. It is 30 minutes whenever it is wanted.*
6. ✅ **M4 persistence: neither Turso nor Qdrant — the existing `better-sqlite3` file.**
   Locked 2026-09-05 with M4.1. The LangGraph checkpointer takes the live
   `SQLITE_CONNECTION` rather than opening its own handle, so short-term memory added a
   dependency and two tables but no new datastore, no second writer on the WAL, and no
   network hop. M4.2's durable facts follow the same path — §5/M4.2 already puts them in the
   existing `sqlite-vec` index under a distinct source.

   Reopen this only if §9's deployment makes the single-file store the binding constraint.
   A recognizable vector-DB name on the README is not worth the integration work while the
   whole corpus is 169 documents.
7. ✅ **Checkpoint retention is bounded per *session*, pruned after every run.** Locked
   2026-09-05 with M4.1. `CHECKPOINT_RETENTION_SESSIONS` (default 50), enforced through
   `CheckpointRepository` from `AgentGraphService`'s `finally` block, so a failed run — the
   one that leaves a half-finished thread — prunes too.

   **This went slightly beyond M4.1 as specified**, which asks only for the checkpointer and
   follow-up handling; forgetting appears in M4's *goal* statement rather than M4.1's spec.
   Three things decided it:
   - A checkpoint is written per **superstep** and carries the whole state, evidence text
     included. Measured on a real three-turn session: 22 checkpoint rows, 93 pending-write
     rows, 231KB — ~77KB per turn, several times what the same conversation costs the trace
     store. So this store grows faster than the one that already has a bound.
   - §9 bakes `database/app.db` into the deployed image, so whatever accumulates in
     development ships with it. That is the identical argument already written down for
     `TRACE_RETENTION_RUNS`, and declining to apply it here would have been the
     inconsistency.
   - Degradation is graceful and silent by design: a pruned session's next question finds
     `turns` empty, `recall` no-ops, and it behaves exactly like a first turn. No error path
     to get wrong.

   *The unit is the session, not the row* — a limit counting rows would keep one long
   conversation and call it fifty. The known wart: the UI's turn counter is client-side, so a
   session pruned mid-conversation would show "turn 5" against an agent with no memory. It
   takes 50 other sessions arriving between two questions in one tab, so it is a curiosity,
   not a defect to fix.

   To drop this: delete the `pruneSessions()` call in `AgentGraphService.run`'s `finally`,
   the port, the adapter and the env var. Nothing else depends on it.
8. ✅ **A session lives as long as the browser tab, not the page load.** Locked 2026-09-05
   with M4.1. `sessionId` is persisted in `sessionStorage`, so a refresh continues the
   conversation and closing the tab ends it.

   The alternative — React state only, which is where M4.1 first landed — meant a reload
   silently started a new conversation. That was an accident of implementation rather than a
   decision, and it is the wrong default: a visitor who refreshes has not changed the subject.
   `sessionStorage` rather than `localStorage` is the point: per-tab and cleared on close is
   exactly the lifetime "short-term memory (within session)" describes, and two tabs asking
   unrelated questions must not share a conversation. `?demo=1` replays are excluded — a
   recording has no session.

---

## 12. Deferred backlog

Not scheduled. Do not pull any of these forward ahead of M1–M6 without the owner asking.

### 12.1 Bring-your-own-data upload

Let a visitor upload `.md` / `.txt` / `.pdf` / `.docx`, index it into a separate namespace,
and ask questions against it.

**Deferred to post-M2**, for three reasons:
- The demo problem it appears to solve ("a visitor won't know what to ask") is already
  solved for free by one-click example questions in M2.
- Re-embedding uploads costs quota and needs writable storage on an otherwise ephemeral
  container — real friction against §9's zero-cost constraint.
- M5's MCP connectors are the stronger version of the same story. "Connects to live Gmail,
  Slack, and Obsidian" beats "you can upload a PDF."

**Clearing up a misconception that will otherwise come up:** uploaded data not being covered
by the eval suite is *not* a problem and is not a reason to avoid building this. Evals
measure the *system* against a fixed benchmark corpus; user data is *usage*. These are
different things and always are — nobody re-runs a benchmark against a user's private
documents. If built, uploads simply index into their own namespace and produce no eval
numbers, which is correct.

### 12.2 Hand-editing fact-bearing corpus documents

LLM-generated prose is more uniform and blander than real workplace writing, which makes
retrieval slightly easier than reality. The noise documents and per-document `brief`s in
`corpus/ledger/documents.yaml` mitigate this but do not eliminate it.

If it becomes a credibility issue, the fix is hand-editing the ~30 fact-bearing documents for
voice and mess — **not** swapping the corpus for a public dataset (§2). The ledger stays the
answer key either way; only the surface prose changes, and the generator's verification pass
will confirm the facts survived the edit.

---

## 13. Sequencing summary

```
M0  Declient + corpus        1–2 days   ← linkable repo exists
M1  Agent graph              4–6 days   ← the differentiator
M2  UI                       3–4 days   ← now it is demoable      ★ MINIMUM VIABLE PORTFOLIO
M3  Observability            2 days
M4  Memory                   3–4 days
M5  MCP connectors           4–6 days
M6  Evals + guardrails + CI  4–5 days   ← the senior signal
```

**Critical path to a defensible portfolio project: M0 → M1 → M2.** If work stops after M2,
what exists is still a real, linkable, demoable project. Everything after adds depth.

If time is short and only one of M3–M6 can be done, **do M6.** Measurement is rarer and more
convincing than features.
