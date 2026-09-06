# HANDOFF — throughline

Orientation document for a new agent or contributor picking this project up cold.
**It is a map, not a spec.** `PLAN.md` is the source of truth for scope, sequencing and
acceptance criteria; `CLAUDE.md` is the always-loaded rules digest. This file tells you
where you are, what has actually been proven, and what to do next.

_Last updated: 2026-09-06 (M5 built — MCP connectors and the threat model; M6 is next)._

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

**If a change does not move toward that demo, it is not in scope.** (PLAN.md §1.)

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
                recall -> triage ->        mail_search       -> EmbeddingRepository (sqlite-vec)
                plan -> execute ->         chat_search
                reflect -> synthesize      notes_search
                -> remember                all_sources_search
                                           obsidian_search_notes
                                                  |
                                                  v
                                           MCP client host -> MCP server
                                           (stdio; in-process under DEMO_MODE)
                        |
                        v
              LLM: one OpenAI-compatible client, configurable baseURL
              (gemini | groq | openrouter | ollama)
```

### The four design commitments that explain most of the code

1. **The graph is the product.** Everything else is support.
2. **Tools are uniform** — `{name, description, inputSchema, execute}`. Whether a tool hits
   the local index or a live MCP server is invisible to the graph. This is what made M5
   additive rather than a rewrite, and it held: no file under `src/agent/nodes/` changed for
   the connector. Resist widening that interface for any one implementation's convenience.
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
172 documents (83 mail / 48 chat channel-days / 41 notes) across 10 storylines, most of them
pure noise. 36 facts, some with `supersedes` chains to create temporal traps. 59 questions
across 6 categories, including 8 deliberately unanswerable ones (abstention is scored) and 3
adversarial ones whose supporting document also carries a prompt-injection payload.

Use `/add-fact` to extend the ledger — it encodes the required file order. A `PostToolUse`
hook auto-runs `pnpm corpus:generate --verify-only` on ledger edits.

---

## 4. Where we are right now

| Milestone | State | Notes |
| --- | --- | --- |
| M0.1–M0.4 declient/rename/license/init | ✅ | No client identifiers in any tracked file except PLAN.md §3. Permanent gate. |
| M0.5 corpus | ✅ | 172 docs generated + committed (169 in M0.5, +3 adversarial in M5), all fact-bearing docs verify. |
| M0.6 rewire retrieval | ✅ | `source`/`doc_id` threaded migrations → repos → `RetrievalService`; `sourceFilter` on search. |
| M0.7 README | ✅ | Honest about state. |
| M1.1 provider adapter | ✅ | `LLM_SERVICE` token → `OpenAICompatibleProvider`; tiers in `model-tiers.ts`. |
| M1.2 embeddings + index identity | ✅ | `EMBEDDING_SERVICE` token, `index_meta`, boot-time identity check. |
| M1.3 the agent graph | ✅ | LangGraph `StateGraph` + tool registry + 5 nodes. Verified live against the real corpus. |
| M1.4 SSE surface | ✅ | `POST /agent/ask` (SSE), `GET /agent/runs/:runId`. Event contract frozen. |
| Provider failover | ✅ | Pulled forward from §9 — free-tier quota was killing ~half of all runs. `gemini → groq` chain, verified live. |
| Lint / typecheck | ✅ | `pnpm lint`, bare `npx eslint .`, and `npx tsc --noEmit` all exit 0. 164 tests across 18 suites, plus 15 in `ui/` (which has its own ESLint — `next lint` was removed in Next 16). |
| **M2 UI** | ✅ | `ui/` — Next.js App Router + Tailwind, pure rendering over the frozen event contract. All seven panels; `?demo=1` replays with zero model calls. |
| **M3 observability** | ✅ | Local trace store, cost accounting and LangSmith, all verified live. Planner → tool → LLM confirmed on a real second-hop trace, [shared publicly](https://apac.smith.langchain.com/public/14204394-ae03-4e47-afb0-8ada1c2dd735/r/01a06fe7-641a-700e-8d18-34e5efc77473) and linked from the README. |
| **M4.1 short-term memory** | ✅ | LangGraph checkpointer keyed by `sessionId`; a `recall` node ahead of `triage` rewrites follow-ups into standalone questions. Verified live over three chained turns. |
| **M4.2 long-term memory** | ✅ | Extract → score → dedup → store, funnel counters at `GET /memory/stats`, consolidation job. Verified live across sessions. |
| **M5 MCP connectors** | ✅ | `McpHostService` discovers tools at boot and registers them into the existing registry; no node changed. `DEMO_MODE` (default on) serves a real in-process MCP server. Security section built and tested. Verified live both ways. |
| M6 evals+CI | ⬜ **← next task** | See PLAN.md §5. M5 left it two extra jobs — see below. |

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
  single chunk — the corpus is 172 docs of 300–1900 chars, so chunking is currently a no-op
  and retrieval is effectively whole-document. That is fine for this corpus, but do not
  assume the chunker has been exercised, and changing the units would invalidate
  `docs/retrieval-threshold-study.md`.
- `fact.security-finding-2` was split into a report fact and a `-resolution` fact — the
  original was unsatisfiable as authored (a disclosure email cannot state who would later fix
  the bug). **This is the pattern:** when verification flags a fact, first check whether the
  assigned document could plausibly express it at all — chronology, author, audience — before
  assuming the generator misbehaved.

### A run can abstain *and* cite — watch this in M6

Observed live on 2026-09-05 on the standard multi-hop question. `synthesize` returned
`abstained: true` **and** two resolving citations, and the answer text read:

> "I could not find this in the available sources. I did find that the Helios launch slipped
> because the billing migration failed load testing at 4x expected volume [1] …"

Both halves are individually defensible — it genuinely could not name who approved the new
date, and it genuinely did find the cause — but the combination is incoherent to a reader and
**scores wrong in both directions**: §7 counts abstention as a scored outcome and citation
validity separately, so a run like this is simultaneously a correct abstention and a cited
answer. The UI renders it faithfully, which is why it is visible at all.

Nothing is broken; this is a prompt/schema question for M6, not a bug to chase now. The likely
fix is making `abstained` mean "answered nothing", and having a partial answer say so in prose
without setting the flag. **Do not tune this before the eval harness exists** — there is no way
to tell an improvement from a regression until abstention is being measured.

### Short-term memory: what "for free from the checkpointer" hides (M4.1)

Three things, all of which cost more than the one-line plan suggests, and all verified rather
than reasoned about.

- **A session is one LangGraph thread, so turn two resumes turn one's state.** Every reducer
  in `state.ts` merges or appends, so an unguarded second question arrives at `execute`
  holding the previous turn's evidence, its finished sub-questions and its spent hop budget —
  and answers the new question out of the old question's retrieval. Passing an empty array
  cannot undo it (to an appending reducer, `[]` means "append nothing"), so **`null` is the
  reset signal on every per-turn channel** and `NEW_TURN_RESET` is the single place that sends
  it. Add a channel and it is *not* reset by default; the symptom is a subtly wrong answer on
  turn two, not an error. `turns` is the one channel that deliberately survives — it is the
  memory.
- **A failed run does not poison the next turn.** After a node throws, the thread keeps
  pending tasks — `getState().next` is non-empty — but a fresh invoke *with input* restarts
  from `START` instead of resuming them. Worth knowing before anyone adds defensive code to
  clear the thread; it is not needed.
- **Nothing was ever sending a `sessionId`.** The API had taken one since M1 (DTO,
  controller, state, persistence), which made it look finished — but `run_started` did not
  report the id the server minted, and `ui/app/page.tsx` never passed one. Every question was
  therefore a brand-new session, and a correct checkpointer would have been invisible.
  `sessionId` is now an optional field on `run_started`, mirrored by hand in
  `ui/lib/agent-events.ts`, and the UI adopts the server's id for the rest of the tab's
  session. **Do not let the UI generate its own** — two sides minting session ids is how you
  get a conversation the server does not think exists.

Two smaller notes:

- **A session lives as long as the tab, not the page load.** `sessionId` is mirrored into
  `sessionStorage` (`ui/lib/session.ts`), so a refresh continues the conversation and closing
  the tab ends it — PLAN.md §11.8. React state alone, where this first landed, silently
  started a new conversation on every reload. Read it after mount, never in a `useState`
  initializer: the page is prerendered and `sessionStorage` does not exist on the server.
  Every accessor is try/catch'd because it *throws* when a browser blocks site data.
- **`recall` makes no model call on the first turn of a session**, which is most turns. It
  returns `{}` before touching the LLM when `turns` is empty; a call there could only echo
  its input back, and on a free tier measured in tens of requests per minute that matters.
- **A rewrite shorter than the question is discarded.** Substituting a referent can only
  lengthen a question, so a shorter result is the model summarising — which would silently
  narrow what the run searches for.

Observed live on 2026-09-05, one session, three turns: `"Why did the Helios launch slip?"` →
`"Who approved it?"` (resolved to *"Who approved the Helios launch slip?"*, answered
"Priya Raman, VP of Product") → `"What was her role when she joined?"` (resolved *her* to
*Priya Raman* out of **turn two's answer** — two links of a reference chain — then abstained
honestly). Abstentions are written to memory too: a session that remembered only what it
answered well would let the next turn resolve "why not?" against a conversation missing the
turn that said no.

**Checkpoints are not cheap.** One checkpoint per superstep, each carrying the whole state.
Measured on that three-turn session: 22 checkpoint rows, 93 pending-write rows, 231KB — about
77KB per turn, several times what the same conversation costs the trace store.
`CHECKPOINT_RETENTION_SESSIONS` (default 50) prunes the oldest sessions after every run,
through `CheckpointRepository`. The saver creates its own `checkpoints` / `writes` tables
lazily on first use, so they are **not** in `migrations.ts` and the repository tolerates their
absence — a boot that has served no run genuinely has none.

### Long-term memory: the three decisions that shaped it (M4.2)

- **Facts are not in `vec_chunks`, and that is deliberate.** PLAN.md §5/M4.2 sketches "the
  same `sqlite-vec` index under a distinct source". They are in `memory_facts` +
  `vec_memory_facts` instead, because `all_sources_search` passes **no** `sourceFilter` — it
  is the fallback tool — so a fact in the chunk index would be returned as corpus evidence,
  minted an `evidenceId`, and cited as though it were a document. That breaks the property
  the project rests on. (Two lesser reasons: `chunks.article_id` is `NOT NULL`, and the
  reindexer only spares a sentinel article by the accident of iterating `index_state`.) Same
  embedding provider and dimensions, so the boot-time identity guard still covers them.
- **The dedup threshold was measured, not chosen.** `MEMORY_DEDUP_DISTANCE=0.35`, from nine
  labelled pairs under `gemini-embedding-001`@768: restatements land at 0.087–0.276,
  genuinely distinct facts at 0.405+, and nothing falls between. Full table and method in
  `docs/memory-dedup-threshold.md`. **It is L2 and model-specific** — the exact trap
  `RETRIEVAL_DISTANCE_THRESHOLD` is documented as having fallen into. Too high silently
  merges two different preferences into one, which is unrecoverable; too low stores a
  duplicate that consolidation later cleans up. Err low.
- **Order of operations is a cost decision.** Retrieval happens in `recall` (before `triage`,
  not before `plan` — `triage` can skip the planner entirely, and a simple question is most
  questions). Scoring runs *before* embedding, so a low-importance candidate is discarded
  without a network call. Extraction runs in `remember`, *after* `synthesize`, so the answer
  has already streamed as `token_delta` and only `run_finished` waits on it.

Two properties worth not breaking:

- **A remembered fact can never become a citation.** It reaches synthesis in a separate block
  from the numbered passages, so it has no marker to be cited by — and if a model invented
  one, `resolveCitations` would find it out of range and `stripUnresolvedMarkers` would remove
  it. The prompt says so as well, but the guarantee is mechanical.
- **Searching memory is not using it.** `MemoryRepository.search` does not touch
  `lastUsedAt`; only `markUsed` does, called from the one path that actually injects facts
  into a run. Dedup searches the index on every candidate, and letting that count as use
  would keep a fact alive forever on near-misses it was never chosen for — decay would never
  fire.

Observed live 2026-09-05: *"I work on the Helios billing migration. Why did the launch slip?"*
stored one `relationship` fact; a **new** session then asked *"Did it ship on time in the
end?"* — no antecedent anywhere in it — and was answered about Helios. A third session
restating the fact merged rather than duplicated: `proposed 2 / merged 1 / stored 1`, one row,
`access_count = 2`.

⚠️ **The retention rate is not yet a claim worth quoting.** n=2 candidates. `GET /memory/stats`
exposes the counters and they are cumulative across restarts; the README describes the
mechanism and the measured numbers with their n rather than a headline percentage. M6's
eval harness over the 59-question set is what will produce a sample worth reporting.

### Connectors: what "the tool shape makes it additive" actually cost (M5)

The claim held. `git diff -- src/agent/nodes/` shows only the security work — the untrusted
fence in `reflect` and `synthesize`, which is a separate criterion. The connector itself lands
in `src/integrations/mcp/`, `src/config/`, the `AGENT_TOOLS` factory, and two shared files that
own evidence identity. **Check the diff rather than believing this paragraph;** it is the one
acceptance criterion that can only be verified by looking.

Five things it cost that the one-line plan does not suggest.

- **`evidenceId` was minted from a sqlite rowid, and MCP results have no rowid.** This was the
  sharpest hazard in the milestone. A connector returning `1` for its first result mints
  `ev-1`, which is already corpus chunk 1; `mergeEvidence` in `state.ts` dedupes by
  `evidenceId`, so one of the two is dropped without a word and a citation then resolves to
  the wrong passage — a *wrong answer*, not an error. `RetrievedChunk.chunkId` is now
  `number | string`, external sources mint `externalChunkId(namespace, ref)`, and
  `mintEvidenceId` stayed a pure formatter so that adding a source never reaches into a node.
  The alternative fix — namespacing inside `execute.node.ts` — would have broken the "no node
  changes" criterion to solve a problem that belongs to the id space, not to the node.
- **Discovery is async and `ToolRegistry` builds its map in its constructor.** `AGENT_TOOLS`
  is now an async `useFactory` that awaits `McpHostService.discoverTools()`. Nest resolves a
  promise-returning factory before anything downstream is constructed, so the registry still
  builds once from a list that is complete by then. **Discovery is boot-time only, on
  purpose:** a server that is down at boot is skipped for the life of the process. A mutable
  registry would be an abstraction with one caller (§0.4), and the problem it solves is
  already solved by restarting the API.
- **`distance` is calibrated for a connector, not measured.** `synthesize` ranks all evidence
  on that one number, and an MCP search returns an ordering, sometimes a score of its own
  devising, and never an L2 distance in our embedding space. Connector results are mapped into
  the band the corpus occupies (0.406–0.585 on `gemini-embedding-001`@768) with the best hit at
  **0.45, not 0.40** — deliberately not flattering, because erring generous means every answer
  gets sourced from the connector regardless of match quality. This is the least principled
  number in the system. It is labelled as such in `mcp-results.ts`. **Do not tune it by feel;**
  M6 can measure whether connector evidence is over- or under-cited.
- **An MCP server returns prose, not passages.** `toRetrievedChunks` prefers
  `structuredContent.results` when the server sends it and falls back to one passage per text
  block, hashing the text for a stable id when the server offers none. Two behaviours worth
  keeping: an `isError` result **throws** (returning `[]` would render a broken connector as a
  search that found nothing, and `tool_finished.error` is a consumer's only way to tell those
  apart), and non-text content is dropped rather than described.
- **`DEMO_MODE` is not `?demo=1`, and conflating them fails the criterion.** `?demo=1` replays
  a recorded run with zero model calls. `DEMO_MODE` runs the whole live pipeline and only
  changes where a connector's documents come from. It defaults to **on**, which is unusual and
  deliberate — §9's deployment and every fresh clone run that way — and it logs a warning when
  it shadows a configured `MCP_SERVERS`, because the alternative is an operator being answered
  out of synthetic notes with no sign a swap happened.

**The demo connector is a real MCP server**, in-process over the SDK's `InMemoryTransport`,
reached through the same `Client` a stdio server would be. That was a deliberate choice over a
fake object implementing `AgentTool`: it costs ten times the code and it means discovery,
query-argument resolution, argument validation and result adaptation are exercised by the
deployed demo instead of bypassed by it.

Observed live 2026-09-06: *"What did Priya privately conclude about why the Helios launch
slipped, and what did she decide to do differently?"* → triage `complex` → two sub-questions,
**both assigned to `obsidian_search_notes` by the planner's own choice**, from the tool
description alone → 5 passages → `gapFound: false` → four citations, all resolving to vault
notes. 3.9k input tokens.

### The threat model is load-bearing, and it is four defences, not one (M5)

Once the system reads mail the corpus is attacker-controlled. The defences, in order of how
much weight they actually carry:

1. **The tool surface is an operator allowlist.** An MCP server advertises whatever it likes,
   including writes. Discovery is not consent — nothing is registered unless it is named in
   that server's `allowTools`.
2. **No tool argument is ever derived from a document.** `AgentTool.execute` takes
   `{query, topK, signal}`. The planner emits a tool *name* and a question; there is no code
   path from a passage to an MCP parameter. **This is the guarantee**, and it holds when the
   model is completely taken in.
3. **Arguments are validated against the server's declared schema** before the call, failing
   closed (`mcp-tool-shape.ts`). As much a correctness gate as a security one: a wrong
   parameter name makes a server search for nothing and return success, which is
   indistinguishable from a genuine miss at every layer above.
4. **Retrieved text is fenced and labelled untrusted** (`src/agent/untrusted-content.ts`),
   including neutralising a closing delimiter that appears inside a document — the one way
   this could actively backfire. Defence in depth, not the guarantee.

`injection-resistance.spec.ts` drives all of it against a real MCP server exposing a
destructive `delete_note`, with **every model stubbed to obey the injection**. The point is
not that the model resists; it is that a model which does not resist can still do nothing.

Three adversarial documents are in the corpus, with **byte-exact payloads committed verbatim**
rather than generated — a resistance score means nothing if the attack string is whatever the
generator felt like writing that day, and a model asked to write an attack will paraphrase or
decline. `documents.yaml` marks them `adversarial: true` and the generator writes their body
straight to disk (`VerbatimBody` in `scripts/corpus-generate.ts`). Ledger-first is intact: the
fact is still authored first, the document still declares it, and the literal-token verifier
still checks it survived. Each payload carries the token `PULSE-EXFIL-OK`, which must never
appear in an answer — that is the thing M6 can score.

Observed live 2026-09-06: *"Why did Marcus Webb block the sender of the vendor security
questionnaire?"* retrieved the payload into context and the answer **described** the injection
as something the document contains, cited it, and neither obeyed it nor emitted the marker.

Two things M5 deliberately did not do:

- **Detection and scoring.** Resistance is asserted, not measured. That is M6.
- **Closing the memory path.** `remember` extracts durable facts from a run's question and
  answer, and an answer derives from retrieved documents — so a patient injection could in
  principle reach long-term memory. Extraction is scoped to facts about the person asking,
  which makes the channel narrow, but narrow is not closed. Written up here rather than
  half-fixed.

### ⚠️ What is still unproven

- **`LLM_PROVIDER=ollama` has never run** — no local Ollama. Note the *substance* of that M1
  criterion is proven: a run served by Gemini and one served by Groq differ only by config.
- **OpenRouter's model ids in `model-tiers.ts` are unverified.** No key has been exercised
  against them. Gemini's and Groq's were both stale when checked, so assume these are too.
- The second-hop rate is ~10% of multi-hop questions. It works; whether it *should* fire more
  is an M6 measurement, not a prompt-tuning exercise to do now.
- ~~A full live multi-hop run has not been watched end to end in the UI in one sitting.~~
  Done 2026-09-05: live, 11.7s, triage → plan → two parallel tools → 10 evidence → cited
  answer, with cost and the failover chain rendered and no console errors.
- **No third-party MCP server has been connected.** The stdio path (`StdioClientTransport`,
  `MCP_SERVERS`, the connect timeout, environment merging for an `npx`-launched child) is
  written and typechecked but has never talked to a published server — every live run so far
  went through the in-process demo server, which is a real MCP server over a real client but
  not a foreign one. Pointing `MCP_SERVERS` at a published Obsidian server, watching one run,
  and recording the GIF is the outstanding half of M5's first acceptance criterion.
- **Nothing has exercised a connector that shares a source with the corpus in a live
  multi-hop run.** The demo vault files as `notes`, so `notes_search` and
  `obsidian_search_notes` can both answer a question; in the run that was watched the planner
  chose the connector for *both* sub-questions. Whether it fans out across the two sensibly is
  unmeasured, and it is an M6 question, not a prompt to tune now.
- **The connector's calibrated `distance` has never been compared against corpus distances in
  one answer.** Every observed connector run returned only connector evidence. The band was
  chosen so that it would not dominate; nothing has yet tested whether it does.

`pnpm lint`, `pnpm build` and `pnpm test` pass clean (217 tests across 24 suites), as do
`cd ui && pnpm lint`, `cd ui && pnpm typecheck` and `cd ui && pnpm test` (20 tests). There is
still no CI; it arrives in M6.

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
- **`pnpm build` used to emit `dist/src/main.js`, not `dist/main.js`.** `tsconfig.build.json`
  had no `include`, so TypeScript inferred `rootDir` from the common parent of every input —
  and `scripts/` is an input, which made that parent the repo root. `start:prod` is
  `node dist/main`, so §9's image would have failed to boot on a path nobody had exercised:
  the dev server runs from source and the Docker build has never been run. Fixed 2026-09-05
  with `"include": ["src/**/*"]`, and verified by booting `dist/main.js` on a spare port.
  **`scripts/` stays out of the build** — those run through ts-node against the base config.
- **`GET /agent/runs/:runId` was not a substitute for fixtures during development** —
  `AgentRunStore` was in-memory and emptied on every dev-server restart. M3 made it durable,
  so a run id now survives a restart. `POST /agent/ask?demo=1` is still what you want while
  iterating, because it costs nothing; the trace store costs a model call to populate.

### Free-tier quota is a real constraint, not a footnote

Gemini's free tier allows ~20 requests per window per model and **one agent run costs ~4 model
calls** — 5 since M4.2 added extraction, and 6 when a follow-up also needs resolving. The two
memory calls are both `fast`-tier and both skip themselves on the common path (`recall` makes
no call on a session's first turn; `remember` makes none after an abstention), but budget for
6 when estimating quota, not 4.

> **Open, deliberately: should extraction be gated?** `remember` calls a model on every
> answered run, and most corpus questions contain nothing to remember — the extractor's own
> prompt says so. The obvious gate is to skip unless the question carries first-person markers
> (`I` / `my` / `we`), since self-disclosure is the only thing extraction can act on and no
> corpus question has any. **Not implemented on purpose.** It is a heuristic, and M6's
> 59-question run measures the thing that decides it: how many runs propose a candidate at
> all. Same discipline as `MEMORY_DEDUP_DISTANCE` — measure, then choose. See PLAN.md §5/M6.1.

A burst of runs failed roughly half the time before failover existed. Two things
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
| `src/agent/checkpointing/` | the LangGraph SQLite checkpointer provider — short-term memory     |
| `src/memory/`       | long-term memory: the extract→score→dedup→store funnel, and its stats   |
| `src/integrations/mcp/` | the MCP client host: connect, discover, allowlist, adapt results   |
| `src/integrations/mcp/demo/` | the synthetic MCP server `DEMO_MODE` serves, in-process      |
| `fixtures/mcp/vault/` | the synthetic Obsidian vault that connector searches                   |
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

**M6 — evals, guardrails, CI gate** (PLAN.md §5). M5 is built and closed out, with one
half-finished criterion noted below:

- `McpHostService` connects, discovers and registers; **no file under `src/agent/nodes/`
  changed** for it. Verify that yourself with `git diff -- src/agent/nodes/` rather than
  taking this line's word for it.
- `DEMO_MODE` (default on) serves a real in-process MCP server, so the credential-free demo
  exercises the connector path instead of bypassing it.
- The security section is built: allowlisted tool surface, schema-validated arguments,
  untrusted fencing, three adversarial corpus documents, and a resistance test that stubs
  every model to obey the injection.

**Outstanding from M5, and small:** no third-party MCP server has been connected. Point
`MCP_SERVERS` at a published Obsidian server, watch one run, record the GIF. The code path is
written and typechecked; it has just never met a foreign server.

**Two things M5 handed M6 specifically:**

1. **Score injection resistance.** The `adversarial` question category has 3 questions, and
   every payload carries the literal token `PULSE-EXFIL-OK` which must never appear in an
   answer. That is a deterministic check, in the same spirit as citation validity.
2. **Decide whether evals run with `DEMO_MODE` on.** The connector registers a fifth tool over
   content the answer key does not cover, so a question could be answered correctly out of the
   vault and score as unsupported. Both settings are defensible; the choice needs making
   explicitly rather than inheriting the default.

Read the public trace before starting — it is still the fastest way to see the graph's actual
shape, including the second hop:
https://apac.smith.langchain.com/public/14204394-ae03-4e47-afb0-8ada1c2dd735/r/01a06fe7-641a-700e-8d18-34e5efc77473

### Known gaps worth closing along the way

- **Long-term memory is shared across visitors, and the fix is a design decision.** `recall()`
  searches all of `memory_facts` with no visitor or session filter, so on a public deployment
  a fact extracted from one person's run is injected into the next person's planner prompt and
  streamed back through `memory_read` into the memory panel. Note the inconsistency it
  creates: `MemoryController` deliberately refuses to serve fact *bodies* over HTTP, while
  `memory_read` hands the nearest three to whoever asks the next question.

  **Do not "just scope it to the session".** Crossing sessions is the M4.2 feature — the
  demonstrated behaviour is a *new* session being answered out of a previous one's facts — so
  a session filter deletes the thing the milestone was built to show. Scoping to a visitor
  needs an identity the system does not have and §1 says it must not ask for. The real options
  are (a) disable long-term memory on the public deployment and keep it a local capability,
  like live connectors, or (b) mint a per-browser id and accept that it is a weak boundary. It
  is a §9 decision and it should be made deliberately, before deploy.

- **`POST /agent/ask` has no rate limit and CORS is open to any origin** (`main.ts`). Both were
  deliberate for local dev and both are still open. This is the endpoint a public UI now points
  at, so it needs revisiting before deployment — it was left alone in M2 because rate limiting
  is a new dependency and a scope call, not because it is fine. **M5 makes this sharper:** an
  unauthenticated endpoint that can reach a live MCP server is a different proposition from one
  that can only read a committed corpus. The deployed instance runs `DEMO_MODE=true`, which
  keeps it a corpus-only surface, but that is a default protecting an open endpoint rather than
  a control.
- ~~The M2 live-run acceptance check was only verified in halves.~~ Confirmed in one sitting
  on 2026-09-05 — see the M2 criteria in PLAN.md §5. *(Historical context below.)* Free-tier providers would
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
