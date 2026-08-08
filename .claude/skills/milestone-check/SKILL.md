---
name: milestone-check
description: Verify a PLAN.md milestone's acceptance criteria and report pass/fail per checkbox. Usage - /milestone-check M1, or /milestone-check with no argument to check the milestone currently in progress.
disable-model-invocation: true
---

# Milestone check

PLAN.md §0.5: *"Every milestone has acceptance criteria. Do not advance until they pass."*
This skill answers whether they actually do.

Argument: `$ARGUMENTS` — a milestone id (`M0`, `M1`, … `M6`) or a sub-milestone (`M0.6`).
If empty, read PLAN.md's "Current status" table and check the first milestone that is not
✅ Done; say which one you picked and why.

## The one rule

**A criterion passes only when you have observed the behaviour it describes.** Code existing
is not evidence. A function named `resolveCitations` does not satisfy "every `[n]` marker
resolves to an `evidenceId`" — running it and seeing markers resolve does. When you cannot
observe it, the verdict is `BLOCKED`, never `PASS`.

This matters here specifically: PLAN.md's status section carries a standing warning that the
embedding/retrieval path was marked done without ever running end-to-end. Do not add to that
pattern.

## Procedure

### 1. Extract the criteria

```bash
grep -n "Acceptance criteria" PLAN.md
```

Read the block for the requested milestone. Each criterion is a `- [ ]` checkbox. Treat the
list as exhaustive and authoritative — do not add criteria of your own, do not skip any.

Also read the milestone body above the criteria; several criteria only make sense with the
sub-section they refer to (e.g. M1's "actionable message from M1.2").

### 2. Sort each criterion by how it can be verified

| Kind | Example | How to handle |
|---|---|---|
| **Shell** | `pnpm build` succeeds; a `grep` returns zero hits | Run it. Report the actual command and its real output. |
| **Runtime HTTP** | `POST /knowledge/reindex`, `GET /knowledge/search?q=…` | Needs the server, and usually Ollama on `:11434`. See §3. |
| **Programmatic assertion** | "every `[n]` resolves to an `evidenceId` — assert this programmatically" | A criterion demanding a test *is* a criterion about a test existing and passing. Find it and run it; if there is no such test, it fails. |
| **Code reading** | "no code change needed when switching provider" | Read and reason, then say explicitly that the verdict rests on reading rather than execution. |

### 3. Runtime criteria

Check prerequisites before concluding anything:

```bash
curl -s http://localhost:11434/api/tags        # Ollama up? (needed for embed + chat)
curl -s http://localhost:3000/ -o /dev/null -w '%{http_code}'   # app up? PORT default 5000, check .env
```

If a prerequisite is missing, ask the user to start it rather than marking the criterion
failed — an unproven criterion and a failed one are different findings. Start long-running
processes in the background and stop anything you started when you are done.

For M0's search criterion, pick real questions from `corpus/questions.yaml` and include one
with a `sourceFilter`, since PLAN.md flags that path as never having run against real vectors.

### 4. Report

A table, one row per checkbox, in PLAN.md's order:

| # | Criterion (abbreviated) | Verdict | Evidence |
|---|---|---|---|

Verdicts: **PASS** (observed), **FAIL** (observed the opposite), **BLOCKED** (could not
observe — say what is needed), **N/A** (with justification).

Evidence means the command and its real output, or the file:line you read. Never paraphrase a
result you did not see.

Then:

- **Verdict line** — "M1 acceptance: 5 PASS / 1 FAIL / 1 BLOCKED. Not ready to advance."
- **What to fix**, in the order that unblocks the most.
- Offer to update PLAN.md's status table **only if every criterion passed**, and only after
  the user says so. Do not tick boxes in PLAN.md yourself.

If a criterion is ambiguous or has been overtaken by a documented deviation, say so and quote
the deviation rather than silently interpreting it — PLAN.md's status section lists deliberate
deviations, and one of them may be the reason a criterion no longer reads true.
