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
| Ask the agent | `curl -N -X POST localhost:5000/agent/ask -H 'Content-Type: application/json' -d '{"question":"..."}'` |
| Replay a recorded run (no model calls) | same, with `?demo=1` — see `GET /agent/demo` for what is available |
| Re-record the demo fixtures | `pnpm capture:runs` (server must be running; `--list` to inspect, `--force` to re-capture) |
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
- **No raw type casts at API boundaries.** Zod schema + validation pipe.
- **Business logic never imports `better-sqlite3`.** It depends on the repository ports in
  `src/repositories/ports/`, bound via DI tokens in `repositories.module.ts`.
- **No abstractions before a second implementation exists** (PLAN.md §0.4).
- Comments explain *why*, not *what*.

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
src/agent/replay/ recorded runs replayed over SSE — the §9 demo fallback, and free UI iteration
src/agent/examples/ corpus/questions.yaml projected for the UI's one-click examples
src/observability/ LangSmith bridge, TraceCollector (span tree), UsageService (cost)
ui/               Next.js UI — its own package and toolchain, deployed separately
fixtures/runs/    captured agent runs (committed); written by `pnpm capture:runs`
src/ai/, src/embeddings/  Ollama chat + embedding clients
corpus/           ledger (ground truth) + generated documents + questions
evals/            eval harness (generalized in M6; currently empty)
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

Three UI traps worth not re-learning:

- **Citation markers are not evidence positions.** `synthesize` sorts evidence by distance
  and truncates before numbering it, so `[5]` is routinely not the fifth chunk retrieved.
  Build marker maps from the `citations` array only.
- **`distance` is lower-is-better** and is not a 0–1 score. Rendering it as a bar without
  inverting shows the best evidence as the weakest. The band in `relevanceFraction` is
  measured against the committed fixtures and is specific to the embedding model.
- **An empty `evidenceIds` does not mean failure.** A search can legitimately match
  nothing; only `tool_finished.error` distinguishes the two. Treating them alike renders a
  failed retrieval as a completed one.

## Known state

M0–M3 are done: retrieval is proven end-to-end (169/169 documents indexed, live agent runs
producing cited answers), the agent is reachable at `POST /agent/ask` (SSE), `ui/` renders
the stream, and runs are traced twice — into sqlite (`runs` + `run_spans`, bounded by
`TRACE_RETENTION_RUNS`) and, when a key is set, to LangSmith. Both show a node → tool → model
tree; each run carries token counts and an estimated cost. M4 (memory) is next.

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

Still open: `LLM_PROVIDER=ollama` has never been exercised; `POST /agent/ask` has no rate
limit and CORS is open to any origin, which needs revisiting before deployment; and a full
live multi-hop run has not been watched end to end in the UI in one sitting (see HANDOFF).

**`HANDOFF.md` is the orientation doc** — read it before PLAN.md if you are picking this up
cold. There is no CI yet; it arrives in M6.
