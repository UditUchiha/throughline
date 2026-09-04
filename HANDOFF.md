# HANDOFF — throughline

Orientation document for a new agent or contributor picking this project up cold.
**It is a map, not a spec.** `PLAN.md` is the source of truth for scope, sequencing and
acceptance criteria; `CLAUDE.md` is the always-loaded rules digest. This file tells you
where you are, what has actually been proven, and what to do next.

_Last updated: 2026-09-04 (M1 complete + provider failover; M2 is next)._

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
LangGraph.js for orchestration (M1.3 onward) · Next.js UI on Vercel (M2) · Node 22, pnpm.

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
| Lint | ✅ | `pnpm lint` passes clean (was 22 errors). |
| **M2 UI** | ⬜ **← next task** | Next.js on Vercel, pure rendering over the frozen event contract. |
| M3 observability · M4 memory · M5 MCP · M6 evals+CI | ⬜ | See PLAN.md §5. |

### What a live run actually does (verified 2026-09-02)

Multi-hop — *"Why did the Helios launch slip, and who approved the new date?"*: triage says
`complex` → plans 2 sub-questions (`notes_search`, `mail_search`) → runs them in parallel →
10 pieces of evidence → `gapFound: false` → cited answer where all 5 citations resolve.
**~10s, 4.3k input tokens.**

Simple — *"When did Tariq Hassan start at Lumen Labs?"*: triage says `simple`, **no
`plan_created` event at all**, one broad retrieval, cited answer. **~4.5s.** That gap is the
triage node paying for itself, and it is a number M6 reports.

Unanswerable — the agent abstains with "I could not find this in the available sources."

### Deviations from PLAN.md as written (deliberate — keep them)

- **Corpus verification is literal-token matching**, not the embedding-similarity check §6
  suggests. Rationale in `scripts/corpus-generate.ts`'s header: "did the exact date survive"
  is the actual failure mode, is fully deterministic, and needs no arbitrary cutoff.
- **Default embedding provider is currently `gemini`**, while PLAN.md §11.4 locks the default
  as _local in-process_ (`fastembed` / `bge-small-en-v1.5`, 384d). The local provider is
  **not yet written**. This matters because §9's offline Docker build depends on it. Treat it
  as an open item for M2, not a settled deviation.
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

`pnpm lint` and `pnpm test` both pass clean. There is still no CI; it arrives in M6.

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

## 7. What to do next

**M2 — the UI** (PLAN.md §5). It is pure rendering: the event contract in
`src/agent/events.ts` is frozen and every event a run emits is already flowing over SSE.

Consume it with `EventSource`-style parsing of `POST /agent/ask` (named events plus the same
JSON in `data`), and render the run as it arrives: sub-questions when `plan_created` lands,
per-tool cards on `tool_started` / `tool_finished` with their latencies, evidence with source
badges and distances, the reflect verdict, then the cited answer with `[n]` markers linking to
their evidence. Ship the one-click example questions — a visitor will not know what to ask.

`GET /agent/runs/:runId` returns a finished run for deep-links and replay.

### Known gaps worth closing along the way

- `token_delta` currently fires once with the whole synthesised answer. Real token streaming
  needs an `LlmService.chatStream` method — the event is already in the contract.
- `AgentRunStore` is in-memory and capped at 100 runs. Durable tracing is M3.
- The two unverified acceptance criteria in §4 above, when Ollama is available.

## 8. Working with this repo as an agent

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
