# throughline

Agentic RAG over scattered work data (mail / chat / notes). Plans a multi-step retrieval
strategy, gathers evidence across sources, and answers with citations.

**`PLAN.md` is the source of truth for scope and sequencing.** It is large — read the section
you need, not the whole file. Index below.

## Commands

| Task | Command |
|---|---|
| Dev server | `pnpm start:dev` |
| Build | `pnpm build` |
| Lint (autofix) | `pnpm lint` |
| Tests | `pnpm test` |
| Re-verify the corpus answer key | `pnpm corpus:generate --verify-only` (no model calls, seconds) |
| Ask the agent | `curl -N -X POST localhost:5000/agent/ask -H 'Content-Type: application/json' -d '{"question":"..."}'` |
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

## Known state

M0 and M1 are done: retrieval **is** proven end-to-end (169/169 documents indexed, live
agent runs producing cited answers), and the agent is reachable at `POST /agent/ask` (SSE)
and `GET /agent/runs/:runId`. M2 (UI) is next.

Still open: `LLM_PROVIDER=ollama` has never been exercised, and no real corpus question has
been seen driving a live second hop.

**`HANDOFF.md` is the orientation doc** — read it before PLAN.md if you are picking this up
cold. There is no CI yet; it arrives in M6.
