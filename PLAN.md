# PLAN.md — Throughline: Agentic RAG over scattered personal/work data

> **Name:** `throughline` — the narrative thread connecting scattered evidence into one
> answer. Decided (§11.1); use it everywhere below, including `package.json`, the repo name,
> and deployed URLs.

**Audience:** an AI coding agent (or the repo owner) executing this plan with no prior context
on the repository. Everything needed to start is in this document.

---

## Current status — read this first

*Authored 2026-08-04. Status last updated 2026-09-04.*

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
| **M2–M6** | ⬜ Not started | **M2 (UI) is the next task.** Unchanged from the plan below. |

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
- §11.4 Default embedding provider: **local in-process** (`fastembed` / `bge-small-en-v1.5`,
  384d), *not* Gemini. This is what keeps the Docker build in §9 offline and keyless.
- §11.2 Corpus setting: accepted as "Lumen Labs" — see §6 and the anti-goal in §2 about
  swapping it for a public dataset.

**Known deviations from this plan as written** (deliberate, keep them):
- `scripts/corpus-generate.ts` verifies facts survived generation by **literal token
  matching** (ISO dates, dollar amounts, `4x`-style multipliers, known entity names extracted
  from each fact statement) rather than §6's suggested embedding-similarity check. Rationale
  is in the script's header comment: an embedding threshold is a fuzzy topical-relevance
  proxy needing an arbitrary cutoff, whereas "did the exact date survive" is the actual
  failure mode and is fully deterministic with no embedding calls.
- The corpus is 169 documents (82 mail / 47 chat channel-days / 40 notes) rather than §6's
  literal counts. Chat documents are channel-*days* containing 3–7 messages each, so total
  message volume lands in the intended range.
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

**Default provider decided: local in-process, not Gemini** (§11.4). This is the one place
where "which cloud key" and "how the free deploy behaves" are the same decision, so the
reasoning is worth stating precisely.

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
memory_read        {refs[]}          // wired in M4, emit empty until then
memory_written     {refs[]}          // wired in M4
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
6. **Memory panel** — empty placeholder until M4. Ship the panel now, wire it later.
7. **Run stats** — total latency, tokens, cost, hop count, provider/model used.

Add a `?demo=1` mode that replays a recorded run from `GET /agent/runs/:id` with no LLM
calls. **This matters more than it sounds:** it guarantees the demo works when free-tier
rate limits are exhausted, and it makes the README GIF trivial to record.

#### Acceptance criteria — M2

- [ ] Local UI renders a full multi-hop run live, all panels populating in order.
- [ ] Citation chips scroll to and highlight the correct evidence.
- [ ] `?demo=1` replays a recorded run with zero API calls.
- [ ] Mobile viewport is usable (recruiters open links on phones).
- [ ] No unhandled promise rejections in the console during a full run.

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

- [ ] A run produces a LangSmith trace with correct span nesting; link works when logged out.
- [ ] `GET /agent/runs/:runId` returns a complete, replayable run.
- [ ] Reported token counts match the provider's own reporting within ~5%.
- [ ] Cost shows `$0.00` on Ollama and a plausible non-zero figure on a paid model.

---

### M4 — Memory *(target: 3–4 days)*

**Goal:** persistence across turns and sessions — with an explicit policy for what *not* to
keep. The forgetting policy is the interesting engineering; unbounded storage is not memory,
it is a log.

#### M4.1 — Short-term (within session)

Use LangGraph's checkpointer with a SQLite saver, keyed by `sessionId`. Gives conversational
continuity and resumable runs largely for free. Add follow-up-question handling: resolve
pronouns against checkpointed history before `triage`.

#### M4.2 — Long-term (across sessions)

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

- [ ] Ask a question, state a preference, ask a follow-up in a new session — the preference
      is retrieved and visibly influences the answer.
- [ ] Stating the same fact twice produces one stored fact with an incremented counter.
- [ ] Memory panel shows reads and writes for a run.
- [ ] Retention funnel counters are exposed and non-trivial (not storing ~everything).
- [ ] Unit tests: dedup merges above threshold and inserts below it; low-importance
      candidates are dropped.

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

- [ ] At least one live MCP connector answers a real question end to end (local demo, GIF).
- [ ] `DEMO_MODE=true` runs the full pipeline with zero external credentials.
- [ ] Adding the MCP connector required **no changes** to `src/agent/nodes/` — verify by
      reviewing the diff.
- [ ] Injected adversarial corpus documents do not cause unauthorized tool calls; the
      behaviour is covered by a test.

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

- [ ] `pnpm eval` produces a metrics table and writes `evals/results-latest.json`.
- [ ] `pnpm eval --baseline=single-shot` runs the non-agentic comparison.
- [ ] README contains a results table with both, and the delta.
- [ ] A deliberately regressing PR fails CI; the failure output names the metric and delta.
- [ ] Every guardrail has a unit test for both pass and fail paths.
- [ ] The LLM judge's agreement with hand labels is measured and reported.

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

### The key move: bake the index into the image

The demo corpus is fixed and read-only, so build the `sqlite-vec` index at Docker build time
and ship it inside the image. No hosted vector database, no cold-start indexing, no cost,
instant boot.

```dockerfile
# builder: pnpm install --frozen-lockfile && pnpm build
#          && node dist/scripts/corpus-index.js   → database/app.db
# runner:  copy dist/ + node_modules/ + database/app.db
#          EXPOSE 7860 (Hugging Face Spaces default)
```

Because §11.4 fixed the default embedding provider to **local in-process** (`fastembed` /
`bge-small-en-v1.5`), `corpus-index.js` needs **no network access and no secret at build
time** — it is a pure ONNX inference pass inside the builder container. This is the direct
payoff of that decision: no Docker build secret to configure on Hugging Face Spaces, no
build-time rate-limit risk on ~360 documents, and the build is reproducible offline. If the
model weights need to be fetched during the build (rather than committed or pulled from a
prior layer), that fetch is a one-time, keyless download from the model host — not an LLM
API call — so it doesn't compete with any provider's request quota.

### Targets

| Piece | Choice | Notes |
|---|---|---|
| Backend + baked index | **Hugging Face Spaces (Docker)** | Genuinely free, no card, recognizable to technical reviewers. Port 7860; set `app_port` in the Space README frontmatter |
| Frontend | **Vercel** free | `NEXT_PUBLIC_API_URL` → Space URL |
| Persistent memory writes (M4+) | **Turso** free (libSQL) or **Qdrant Cloud** free | Turso is SQLite-compatible → smallest diff from `better-sqlite3` |
| Tracing | **LangSmith** free personal tier | |
| Inference (chat) | Gemini free tier (default), Groq free (`fast` tier) | Embeddings are local in-process (§11.4) — not part of this quota at all |

**Two warnings:**
- **Do not run the agent loop on Vercel serverless.** Function timeouts will kill 30–90s
  multi-hop runs. Frontend only.
- **Render's free tier spins down after ~15 minutes idle with a ~50s cold start** — exactly
  the wrong behaviour when a reviewer clicks your link. Prefer HF Spaces.

Free tiers change. Verify current limits at implementation time rather than trusting this
table.

### Rate-limit resilience

Free tiers will be exhausted at some point, and it will happen while someone is looking.
Handle it: catch quota errors, fall back to the next configured provider, and if all fail,
serve a recorded run via `?demo=1` with an honest banner. A demo that degrades gracefully is
more impressive than one that 500s.

---

## 10. Resume output

The point of the project. Draft after M6; these are targets to build toward, and **every
number must be real and reproducible from `evals/results-latest.json`.**

**Project entry** (replaces the Real-Time Collaborative Whiteboard entry, which is generic;
keep the Rubik's Cube Solver — the pattern databases and IDA* are the strongest technical
signal on the page):

> **Throughline — Agentic RAG over multi-source data** *(TypeScript, NestJS, LangGraph, MCP, LangSmith, Next.js)*
> - LangGraph planner decomposes questions into sub-questions, fans out to mail/chat/notes
>   tools in parallel, and re-queries on detected gaps; multi-hop eval set shows **X%**
>   answer accuracy vs **Y%** for single-shot RAG.
> - Long-term memory with LLM fact extraction, embedding dedup, and TTL consolidation —
>   retains **Z%** of candidate facts instead of logging every turn.
> - Eval-gated CI: **N**-question golden set scoring recall@k, citation faithfulness, and
>   abstention; PRs fail on regression. Full LangSmith tracing with per-run token and cost
>   accounting.

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
2. **Corpus setting.** "Lumen Labs" is a suggestion. Any fictional company works; the schema
   matters, the theme does not. *Recommendation: accept and move on — this is not worth
   deliberating.*
3. **Default chat provider.** *Recommendation: Gemini free tier* — best free-tier chat
   quality, one key. Groq as the `fast` tier (routing/triage/sub-question generation).
4. ✅ **Default embedding provider: local in-process.** Locked 2026-08-04. A JS-native model
   (e.g. `bge-small-en-v1.5` via `fastembed-js` or `@xenova/transformers`, 384d) runs inside
   the Node process — no API key, no daemon, no network call, at build time or runtime. This
   is what keeps the Docker deploy in §9 genuinely simple: the index bakes into the image
   fully offline. Gemini and Ollama embedding providers are still implemented behind the
   `EmbeddingProvider` interface (the "switchable" claim needs at least one alternative to be
   true), but neither is the default. See M1.2 for the concrete change this implies.
5. **Anthropic support.** Owner has a key but prefers not to spend it. *Recommendation: leave
   the seam, do not implement. It is 30 minutes whenever it is wanted.*
6. **Turso vs. Qdrant for M4 persistence.** *Recommendation: defer to M4. Turso if the
   SQLite-compatible path holds; Qdrant if a recognizable vector-DB name is worth the extra
   integration work.*

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
