# throughline

Agentic RAG over scattered work data (mail / chat / notes). Plans a multi-step retrieval
strategy, gathers evidence across sources, and answers with citations.

**`PLAN.md` is the source of truth for scope and sequencing.** It is large — read the section
you need, not the whole file. Index below.

## Commands

| Task | Command |
|---|---|
| Dev server (API, :5000) | `pnpm start:dev` |
| Dev server (UI, :3000) | `cd ui && pnpm dev` — open `/?demo=1` to spend no quota |
| Build | `pnpm build` |
| Lint (autofix) | `pnpm lint` |
| Tests | `pnpm test` |
| UI checks | `cd ui && pnpm lint && pnpm typecheck && pnpm test` |
| Re-verify the corpus answer key | `pnpm corpus:generate --verify-only` (no model calls, seconds) |
| Eval suite (agent) | `pnpm eval` — `--subset=pr` for the 9-question CI subset, `--no-judge` for zero model calls. Only a full pass writes `results-latest.json`; narrowed runs write elsewhere |
| Eval suite (control) | `pnpm eval --baseline=single-shot` |
| Regression gate | `pnpm eval:compare` · conventions gate: `pnpm check:conventions` |
| Re-derive a scored cutoff | `pnpm eval:sweep` (reads `evals/results-latest.json`, no model calls) |
| Validate the LLM judge | `pnpm eval:judge-agreement` (20 hand labels, 20 model calls) |
| Ask the agent | `curl -N -X POST localhost:5000/agent/ask -H 'Content-Type: application/json' -d '{"question":"..."}'` |
| Ask a follow-up | same, plus `"sessionId":"<the id from run_started>"` |
| Memory retention funnel | `curl -s localhost:5000/memory/stats` |
| Check M5's "no node changes" claim | `git diff <m4-commit> -- src/agent/nodes/` — only `reflect`/`synthesize` should appear, and only for the untrusted fence |
| Replay a recorded run (no model calls) | same, with `?demo=1` — see `GET /agent/demo` for what is available |
| Re-record the demo fixtures | `pnpm capture:runs` (server must be running; `--list` to inspect, `--force` to re-capture) |
| Rebuild the baked index (keyless) | `EMBEDDING_PROVIDER=precomputed pnpm corpus:index` — seconds, no model calls |
| Is the vector artifact current? | `pnpm corpus:vectors --check` (free; CI runs it) · regenerate with `--from-index` |
| Build + boot the deployment image | `docker build -t throughline . && docker run --rm -p 7860:7860 -e GEMINI_API_KEY=... -e EMBEDDING_API_KEY=... throughline` |
| Regenerate corpus docs for one fact | `pnpm corpus:generate --only=fact.<id>` (needs `GEMINI_API_KEY`) |

Node 22+, pnpm. Local Ollama on `:11434` is required for embeddings and chat
(`ollama pull bge-m3`).

## Non-negotiable conventions (PLAN.md §0.3)

These describe the existing bar; match it.

- **No module-level singletons.** No `export const x = new X()`. Everything is `@Injectable()`
  and wired through Nest DI.
- **No `process.env` reads outside `src/config/`.** Everything goes through
  `AppConfigService`; new variables are added to `src/config/env.schema.ts` (Zod) first.
- **No `console.log`.** Use the NestJS `Logger` / Pino.
- **No raw type casts at *any* untrusted boundary.** HTTP in and out of a `ZodValidationPipe`
  — including query strings, where `@Query('q') q: string` is a declaration and not a check
  (a repeated `?q=a&q=b` is an array, and `.trim()` on it is a 500). **A model's reply is a
  boundary too**, and was the last one exempt: `parseJsonObject` now *requires* a Zod schema,
  because returning `parsed as T` meant `plan` called `.map()` on whatever the model sent and
  `recall` called `.trim()` on it. Every node already had a fallback for a `null` return; the
  cast is what stopped those from being reached. Note this validates what comes *back* —
  each node's `RESPONSE_SCHEMA` (what is sent) is hand-written JSON Schema proven against the
  live providers, and regenerating it is a change whose failure mode is invisible without
  quota to test it.
- **Domain unions are declared once, as a const tuple with a type guard.**
  `CORPUS_SOURCES` + `isCorpusSource` in `src/common/types/knowledge.types.ts` is the source
  of truth; `CorpusSource` is derived from it. The loader and the examples projection each
  used to restate the same three strings, and a `source` read out of sqlite was cast rather
  than checked. `src/config/env.schema.ts` keeps its own copy deliberately — the env schema is
  parsed before anything else exists and stays free of domain imports.
- **Business logic never imports `better-sqlite3`.** It depends on the repository ports in
  `src/repositories/ports/`, bound via DI tokens in `repositories.module.ts`.
- **No abstractions before a second implementation exists** (PLAN.md §0.4).
- Comments explain *why*, not *what*.
- **Set `process.env` before importing anything that reaches `src/config/config.module.ts`.**
  `@nestjs/config` reads the environment inside that file's `@Module` decorator, so it
  snapshots at *import* time — a runner that assigns `process.env` in `main()` has already
  missed its chance and will run against whatever was there before, silently. Load the module
  graph with a deferred `require` after the environment is set (`await import()` does not work
  — under `module: nodenext` TypeScript emits genuine ESM even from a CommonJS file and Node's
  resolver rejects an extensionless specifier), and verify the settings landed rather than
  assuming. This cost M6 its entire measurement; see `evals/harness/context.ts`.

## Anti-goals — do not build these (PLAN.md §2)

Deliberate exclusions. Ask before reintroducing any of them:

PostgreSQL/pgvector repositories · separate LLM provider classes + router (one
OpenAI-compatible client with a configurable `baseURL` instead) · hand-rolled agent
orchestration (LangGraph.js is the chosen dependency) · the two client helpdesk/ticketing
integrations named in §2 · a separate guardrails repo (it is M6 here) · replacing the synthetic
corpus with a public dataset · gating the demo behind user-uploaded data.

This is a **public** repo converted from client work. The client identifiers listed in PLAN.md
§3 must never appear in any tracked file except PLAN.md itself — M0's acceptance criteria make
that a permanent gate.

## The corpus is an answer key, not test data

`corpus/ledger/{entities,facts,documents}.yaml` is human-authored ground truth;
`corpus/generated/**` is LLM-written prose expressing it; `corpus/questions.yaml` derives
questions from fact ids. Facts are authored **first** — never write a question by reading a
generated document.

Editing any of those files changes what the eval suite measures. A `PostToolUse` hook runs
`--verify-only` automatically on such edits; if it reports a fact missing, first check whether
the assigned document could plausibly express it at all (chronology, author, audience) before
assuming the generator misbehaved — see the `fact.security-finding-2` note in PLAN.md's
status section.

Use `/add-fact` to extend the ledger; it encodes the required file order.

## Repo layout

```
src/config/       Zod env schema + AppConfigService — the only place env is read
src/repositories/ ports/ (interfaces + DI tokens) and sqlite/ (adapters)
src/knowledge/    markdown loader, chunker, idempotent indexing service
src/rag/          RetrievalService — vector search over sqlite-vec
src/agent/        LangGraph graph: state, nodes, tools, frozen event contract, SSE controller
src/agent/checkpointing/ LangGraph SQLite checkpointer provider — short-term memory (M4.1)
src/memory/       long-term memory: extract → score → dedup → store, plus GET /memory/stats
src/agent/replay/ recorded runs replayed over SSE — the §9 demo fallback, and free UI iteration
src/integrations/mcp/ MCP client host: connect → discover → allowlist → adapt (M5)
src/integrations/mcp/demo/ the in-process MCP server DEMO_MODE serves
src/guardrails/   five deterministic checks in two stages; run live AND scored by evals (M6)
src/agent/examples/ corpus/questions.yaml projected for the UI's one-click examples
corpus/index/    committed embedding vectors — what makes the Docker index build keyless (§9)
src/observability/ LangSmith bridge, TraceCollector (span tree), UsageService (cost)
ui/               Next.js UI — its own package and toolchain, deployed separately
fixtures/runs/    captured agent runs (committed); written by `pnpm capture:runs`
fixtures/mcp/vault/ the synthetic Obsidian vault the demo connector searches
src/ai/, src/embeddings/  Ollama chat + embedding clients
corpus/           ledger (ground truth) + generated documents + questions
evals/            the eval harness — see evals/README.md before touching it (M6)
scripts/          one-off authoring tools, run outside the Nest context
```

## PLAN.md section index

| Need | Section |
|---|---|
| What's done, what's next, open warnings | "Current status — read this first" (top) |
| Rules of engagement | §0 |
| Anti-goals | §2 |
| Target architecture + design commitments | §4 |
| Milestone specs and acceptance criteria | §5 (M0–M6) |
| Corpus + ledger specification | §6 |
| Eval metrics definitions | §7 |
| Deployment (HF Spaces, baked index) | §9 |
| Locked decisions — do not re-litigate | §11 |
| Deferred backlog | §12 |

## The UI mirrors the event contract — keep them in step

There are **two** hand-kept copies, because the UI deploys separately and cannot import
across the boundary:

- `ui/lib/agent-events.ts` mirrors `src/agent/events.ts`. Add an event variant on the API
  side and you must add it here too; `cd ui && pnpm test` replays the real
  `fixtures/runs/*.json` through the UI reducer and fails on drift.
- `ui/lib/api.ts` mirrors `src/agent/examples/example-question.ts` (the `/agent/examples`
  payload). **Nothing pins this one**, so it drifts silently — keep `QuestionCategory` open
  rather than a closed union, so a category added on the API side renders with its raw name
  instead of vanishing from the list.

Five UI traps worth not re-learning:

- **`sessionId` has to come back from the server.** `run_started` carries it; `ui/app/page.tsx`
  adopts it and sends it with the next question. The UI must never mint its own — that is how
  you get a conversation the server does not think exists. Without this plumbing short-term
  memory is invisible no matter how correct the checkpointer is, which is exactly the state
  M4.1 found the code in.
- **Citation markers are not evidence positions.** `synthesize` sorts evidence by distance
  and truncates before numbering it, so `[5]` is routinely not the fifth chunk retrieved.
  Build marker maps from the `citations` array only.
- **`distance` is lower-is-better** and is not a 0–1 score. Rendering it as a bar without
  inverting shows the best evidence as the weakest. The band in `relevanceFraction` is
  measured against the committed fixtures and is specific to the embedding model.
- **An empty `evidenceIds` does not mean failure.** A search can legitimately match
  nothing; only `tool_finished.error` distinguishes the two. Treating them alike renders a
  failed retrieval as a completed one.
- **`CorpusSource` is open, and must stay open.** It was a closed union until M5, which made
  `SOURCE_STYLES[source]` return `undefined` and throw on `.className` for any source the API
  added — the same bug class as `QuestionCategory`. `sourceStyle` now falls back to a neutral
  style labelled with the raw name, and `EvidencePanel`'s `groupBySource` appends unknown
  sources rather than filtering them out, which was the same bug silently.

## Deployment (§9) — what is decided

Built 2026-09-06; the image has been built, booted and exercised in a container, and CI does the
same on every push. Six things to know before touching any of it:

- **The index is baked into the image, and that is load-bearing rather than an optimisation.**
  Every free host has an ephemeral filesystem; on Render's free tier a restart is every fifteen
  idle minutes. Indexing at boot would cost ~172 embedding calls per wake against a ~20/window
  free tier — the instance would come back rate-limited, not just slow. `indexed=0 skipped=172`
  in the boot log is the assertion CI makes.
- **The build is keyless because the vectors ship, not the database.**
  `corpus/index/embeddings.json` is ~700KB keyed by a hash of each chunk's text;
  `EMBEDDING_PROVIDER=precomputed` replays it. Shipping the `.db` instead would be 6× larger
  (sqlite-vec allocates a full 1024-row chunk) and opaque. `precomputed` is **build-time only** —
  a server started with it fails on the first question, because a question is not in the artifact.
  Regenerate with `pnpm corpus:vectors --from-index` (free) whenever the corpus or `CHUNK_SIZE`
  changes; `--check` runs in CI and catches forgetting.
- **The image builds a fresh database.** That is what keeps a developer's traces and checkpoints
  (~9.6MB of the local 14MB file) out of it — there is nothing to remember to clear.
- **`LONG_TERM_MEMORY=false` on the public instance.** `recall()` has no visitor filter and
  crossing sessions *is* the M4.2 feature, so a session filter would delete what the milestone
  shows. Long-term memory is a local capability, like live connectors. Off means "not consulted",
  not "erased".
- **`POST /agent/ask` is rate limited**, 5 questions / 10 min / IP, `?demo=1` exempt.
  `TRUST_PROXY_HOPS` is load-bearing: at 0 behind a proxy every visitor shares one bucket.
- **The quota fallback arms on `AllProvidersFailedError.quotaOnly` only.** A timeout or an
  unreachable provider is an outage, and replaying a fixture for one would present a broken
  system as a working demo. It diverts the *next* request, not the failing one, because
  `run_replayed` is contractually a replay's first event.

## Known state

M0–M6 are done: retrieval is proven end-to-end (172/172 documents indexed), the agent is
reachable at `POST /agent/ask` (SSE), `ui/` renders the stream, runs are traced twice — into
sqlite (`runs` + `run_spans`, bounded by `TRACE_RETENTION_RUNS`) and, when a key is set, to
LangSmith — the agent remembers both within a session and across sessions, MCP connectors join
the same tool registry, and an eval suite scores the whole thing against the answer key with a
CI gate on top. §9 deployment is built — image, blueprint, rate limit, quota fallback — and
**what remains is pushing it to a host, which is an account action rather than a code one.**

⚠️ **M6's numbers were measured with the demo connector live while recording
`connectors: false`.** §9 found the cause: `@nestjs/config` snapshots `process.env` inside the
`@Module` decorator, so `evals/harness/context.ts` importing `AppModule` before calling
`applyEnvironment()` meant none of its settings applied — the isolated database was created and
never written to either. Fixed, with a `verifyEnvironment` check that throws rather than trusting
the flags; **the numbers below are owed a re-run**, which is quota rather than work.

M6's numbers, over all 59 questions (see README and HANDOFF): answer correctness **61.0%**
(96.6% with partial credit), citation support 88.4%, abstention correctness 100%, recall@k
92.5%, citation validity 100%, injection resistance 100% over the 9 runs that retrieved a
payload. 0 failed, 0 unjudged, $0.13.

⚠️ **One M6 acceptance criterion is outstanding:** the agent-vs-baseline delta. The agent pass
exhausted the day's free tier on both providers, so `pnpm eval --baseline=single-shot` returned
`rate limit reached` for 56 of 59. A second attempt on 2026-09-06 got **21 of 59** through
before both providers' *daily* caps went; those 21 are cached, failed runs are not, so the next
attempt pays only for the remaining 38. PLAN.md §5/M6 leaves that box **un-ticked** on purpose.

Six things about `evals/` and `src/guardrails/` worth knowing before touching either — the
full argument is in `evals/README.md`:

- **The suite runs with connectors OFF and long-term memory RESET between questions.** Both
  would otherwise be inherited from the environment and quietly change what is measured:
  `DEMO_MODE` defaults to *on*, and the vault it serves is not in the answer key; and `recall`
  + `remember` make 59 sequential questions order-dependent. Both settings are recorded in
  `results-latest.json` with every run and both have a flag to invert them.
- **The judge is separated by provider, not by tier.** PLAN.md §7 asks for a different tier;
  on the free tier `deep` resolves to the same model as `default`, so that separation does not
  exist here. Gemini answers, Groq judges. When even that is unavailable the results record
  `separateProvider: false` and the table prints a warning. One judge call per question returns
  all three judged verdicts, so **they are not independent judgments**.
- **A failed run is never cached, and a judge failure degrades one question rather than the
  suite.** Both learned the hard way — a quota wall wrote 56 failures into the cache, and one
  transient judge error ended a 35-question pass. A cache whose purpose is "a killed run
  resumes" must not persist the thing that killed it.
- **`citationValidity` rises as the agent cites less**, because an answer with no markers is
  vacuously valid. The suite reports `cited / answered` beside it for exactly that reason —
  and on the first run that gap was 43/50. The same property is why **`pnpm eval:compare`
  refuses to gate a run that failed more than 10%**: a failed run scores zero rather than
  being dropped, but the two metrics carrying *hard floors* are computed over the runs that
  returned, so a quota outage passed every check while measuring nothing. The committed
  `single-shot` mode (38 of 59 failed, `citationValidity: 1`) is the specimen, and
  `evals/compare.spec.ts` pins it. **`renderTable` guards both sides** — the current mode as
  well as the one it is compared against. Guarding only the latter let the walled baseline
  print `single-shot 66.7% vs agent 61.0%, +5.6pp`: the control beating the agent, because
  judged rates use the denominator a judge actually saw while the deterministic ones score
  every failure as zero. Half the column read high and half read low.
- **Guardrails run on every live request, not only under the harness.** `AgentController` runs
  the input stage before the SSE stream opens; `AgentGraphService` runs the post-run stage
  after `run_finished` and returns the verdicts on `AgentRunResult`. They are *not* on the
  event contract, which stays frozen. Only `question-abuse` can refuse anything, and only on
  size and padding — blocking on injection vocabulary would refuse `q.assistant-injection-policy`,
  which is one of the questions the suite scores. Three consequences of that placement:
  **severity is per *verdict*, not per guardrail** (the allowed injection finding reports `warn`
  even though the guardrail is declared `block`, or every run of that question logs an ERROR);
  **`blocks` is derived, `input` stage only** (an `output` guardrail runs after `run_finished`,
  so `exfiltration` is `block` severity and blocks nothing — ask `GuardrailService.blocked()`
  rather than importing a concrete guardrail); and **the post-run sweep cannot throw out of
  itself** — it is wrapped, because the enclosing `catch` would emit `run_failed` after
  `run_finished` and record `answer: null` over an answer the client already received.
- **Extraction is now gated on first-person markers** (`mentionsSelf`), decided by M6's
  measurement of 0 candidates proposed across 59 runs. It saves a model call per corpus-style
  run and closes the document-to-memory injection path. The committed results **predate** the
  gate deliberately — they are its evidence — and a `skippedNoSelfReference` funnel counter
  keeps "the gate fired" distinguishable from "the extractor found nothing" afterwards.

Connectors are `src/integrations/mcp/` (M5). `McpHostService` connects to configured servers at
boot, discovers their tools, and returns plain `AgentTool`s — the graph never learns MCP exists,
and **no file under `src/agent/nodes/` changed for it**. Five things to know:

- **`evidenceId` is namespaced for anything outside the chunk index.** `RetrievedChunk.chunkId`
  is `number | string`; corpus chunks use the sqlite rowid, connectors use
  `externalChunkId(namespace, ref)`. A connector returning a bare `1` would mint `ev-1`, collide
  with corpus chunk 1, and `mergeEvidence` would drop one silently — a wrong answer, not an
  error. `mintEvidenceId` stays a pure formatter so a new source never reaches into a node.
- **Discovery is boot-time only.** `AGENT_TOOLS` is an async `useFactory` that awaits the host;
  `ToolRegistry` still builds its map once, in its constructor. A server down at boot is skipped
  for the process's life. Deliberate — a mutable registry is an abstraction with one caller.
- **`DEMO_MODE` is not `?demo=1`.** `?demo=1` replays a fixture with zero model calls;
  `DEMO_MODE` (default **on**) runs the whole live pipeline and only changes where a connector's
  documents come from. It warns when it shadows a configured `MCP_SERVERS`. The demo connector
  is a *real* MCP server over an in-memory transport, not a stub.
- **A connector's `distance` is calibrated, not measured.** `synthesize` ranks all evidence on
  that one number and an MCP search has no L2 distance to give. Connector hits map into the
  measured corpus band with the best at 0.45 rather than 0.40. Least principled number in the
  system; do not tune it by feel, M6 can measure it.
- **An empty result must not become a passage.** A server that answers a miss with prose
  ("No matching notes.") will have that text adapted into evidence unless the empty case is
  caught first — and a lone unscored passage used to take the *best* distance a connector can
  produce, so a failed search outranked real corpus evidence. `readStructured` returns `[]`
  for an explicitly empty list, and `relevanceFromRank` puts a lone result mid-band.
- **Discovery is not consent.** Only tools named in a server's `allowTools` are registered,
  and a tool whose other required arguments this host cannot supply is skipped at bind time —
  resolving a query parameter is not the same as being able to call the thing.
  That plus "no tool argument is ever derived from a document" is the actual injection
  guarantee; the untrusted fence in `src/agent/untrusted-content.ts` is defence in depth.
  Adversarial corpus documents are `adversarial: true` in `documents.yaml` with `verbatim`
  bodies — payloads must be byte-exact, so the generator writes them without a model call.

Memory is two halves. Long-term (M4.2) is `src/memory/` — a `fast`-tier extraction after each
run, scored against `MEMORY_IMPORTANCE_FLOOR`, deduplicated by embedding distance, with funnel
counters at `GET /memory/stats`. Three things about it:

- **Facts live in `memory_facts` + `vec_memory_facts`, not in `vec_chunks`** — deliberately
  against PLAN.md §5/M4.2's sketch. `all_sources_search` passes no `sourceFilter`, so a fact
  in the chunk index would be retrieved as corpus evidence and cited as a document.
- **`MEMORY_DEDUP_DISTANCE` is L2 and model-specific.** Measured for
  `gemini-embedding-001`@768 in `docs/memory-dedup-threshold.md`. Re-derive it if
  `EMBEDDING_MODEL` changes; too high merges two different preferences irrecoverably.
- **Searching memory is not using it.** Only `markUsed` stamps `lastUsedAt`, from the one
  path that injects facts into a run — dedup searches on every candidate, and counting that
  as use would mean decay never fires. **`MEMORY_RECALL_DISTANCE` is the other half of that:**
  `search` returns the k *nearest* however far away they are, so without a ceiling a store
  smaller than `MEMORY_TOP_K` handed every fact to every question *and* stamped them all,
  which kept decay from ever finding a candidate. Filter before the stamp.
- **Long-term memory has no per-visitor scope, and that is an open decision, not a bug to
  patch casually.** `recall()` searches all of `memory_facts`. Cross-session is the M4.2
  feature; on a public deployment with no sign-in, cross-session is also cross-visitor. See
  HANDOFF's known gaps before changing it — the obvious fix deletes the feature.

Short-term memory (M4.1) is a LangGraph checkpointer keyed by `sessionId` over the existing
sqlite connection, plus a `recall` node ahead of `triage` that rewrites a follow-up into a
standalone question. Three things to know before touching it:

- **A session is one thread, so every per-turn channel must be explicitly cleared.** The
  reducers in `state.ts` merge or append, and `[]` cannot express a reset — `null` can. Add a
  channel and it is *not* reset by default; `NEW_TURN_RESET` is the one place that sends the
  signal, and the failure mode is a wrong answer on turn two rather than an error.
- **The checkpointer is not behind a repository port, deliberately.** It is LangGraph
  infrastructure and `BaseCheckpointSaver` is already the interface; it shares
  `SQLITE_CONNECTION` rather than opening a second handle. *Forgetting* is ours and does have
  a port — `CheckpointRepository`, bounded by `CHECKPOINT_RETENTION_SESSIONS`.
- **The checkpoint tables are created by the saver, not `migrations.ts`**, lazily on first
  write — so anything reading them must tolerate their absence.

Three things about tracing worth knowing before touching it:

- **`?demo=1` writes no trace, by design.** A replay does not run the graph, so it is not a
  run. Verifying the trace store needs a live call.
- **LangGraph's auto-tracing covers neither model calls nor tools.** Model calls go through
  the raw `openai` SDK and tools are plain functions, so those two levels of a LangSmith
  trace exist only because `LangSmithTracing.wrapClient` and `.traceTool` supply them.
  Removing either loses a level silently.
- **`LANGSMITH_ENDPOINT` must match the account's region** (US / EU / APAC). A mismatch 403s
  every authenticated call while unauthenticated ones still return 200, so it presents as a
  bad key rather than a wrong host.

Still open: `LLM_PROVIDER=ollama` has never been exercised; **no third-party MCP server has
been connected** — the stdio path is written but every live run so far went through the
in-process demo server; and the deployment has not been pushed to a host yet. (`POST /agent/ask`
is rate limited as of §9; CORS stays open deliberately — see the Deployment section above.)

**`HANDOFF.md` is the orientation doc** — read it before PLAN.md if you are picking this up
cold. There is no CI yet; it arrives in M6.
