# evals

The eval harness, the guardrail scores, and the CI gate (PLAN.md §5/M6, §7).

Everything here answers one question: **does the agent actually beat single-shot RAG, and can
you check?** The corpus is an answer key rather than test data (`corpus/ledger/*.yaml` is
hand-authored ground truth), which is what lets most of these metrics be set-membership tests
instead of LLM judgments.

```bash
pnpm eval                          # the agent, all 59 questions
pnpm eval --baseline=single-shot   # the non-agentic control, same questions
pnpm eval --subset=pr              # the nine-question CI subset
pnpm eval --no-judge               # deterministic metrics only — zero model calls
pnpm eval --help                   # every flag

pnpm eval:compare                  # results vs evals/baseline.json; exits 1 on a regression
pnpm eval:sweep                    # re-derive RETRIEVAL_DISTANCE_THRESHOLD from a finished run
pnpm eval:judge-agreement          # the judge vs 20 hand labels
```

---

## Quota is the binding constraint, not a footnote

| Pass | Model calls |
| --- | --- |
| Agent, 59 questions (~5 calls each) | ~295 |
| Judging those 59 (1 call each) | ~59 |
| Single-shot baseline, 59 questions | ~59 |
| Judging those | ~59 |
| **Full comparison** | **~470** |

Gemini's free tier answers roughly **20 requests per window**. A full comparison is therefore
hours, not minutes, and **it will be interrupted** — by quota, by a 429 storm no failover
absorbs, by a laptop closing.

The harness is built around that:

- **Per-question caching.** Runs and judgments are cached separately under `evals/.cache/`
  (gitignored), keyed by a fingerprint of everything that changes what a run *means*: mode,
  provider chain, embedding model, `TOP_K`, `MAX_HOPS`, connectors, memory mode, and the
  registered tool menu. A killed run resumes; it does not restart. A judgment additionally
  keys on a hash of the answer it was made about, so a re-run's new answer can never inherit
  the verdict for the answer it replaced.
- **`--only`, `--category`, `--subset`, `--limit`** narrow real work.
- **`--no-judge`** re-scores everything deterministic for free.
- **`results-latest.json` is merged, not overwritten**, so the agent pass and the baseline
  pass can be run hours apart and still produce one comparison table. Merged *per mode*, which
  means a mode is replaced wholesale — so **only a full pass writes it**. `--subset=pr` writes
  `results-pr-subset.json` and any other narrowing writes `results-partial.json` (gitignored).
  `--out` overrides all three. Before that split, the command printed in three of this repo's
  documents overwrote the 59-question numbers the README cites with nine questions.

**A full run needs a billed key or several hours.** That is a property of the project's zero-cost
constraint (§9), not a defect in the harness.

---

## Two decisions the suite makes for you

Both are the kind that produce a plausible-looking number while measuring the wrong thing, so
they are made explicitly and written into `results-latest.json` with every run.

### 1. Connectors are off

`DEMO_MODE` defaults to **on**, so merely booting a Nest context registers a fifth tool —
`obsidian_search_notes` over the synthetic vault in `fixtures/mcp/vault/`. The answer key does
not cover that vault. A question answered correctly out of it would score as unsupported, and
`requiredSources` would be measuring source coverage against documents the ledger has never
heard of.

So the harness sets `DEMO_MODE=false` and `MCP_SERVERS=[]` before boot. Pass `--connectors` to
measure the connector deliberately; the setting is recorded either way.

### 2. Long-term memory is reset between questions

`recall` injects remembered facts into the planner before `triage`; `remember` writes after
every answered run. Run 59 questions in sequence and question 30 is influenced by facts
extracted from questions 1–29 — the suite becomes order-dependent and stops being
reproducible. But PLAN.md §5/M6.1 also wants the **memory funnel yield** measured over the
same 59 runs, which needs memory on. The two requirements pull opposite ways.

The default, `--memory=reset`, clears the stored facts between questions. Memory stays fully
enabled — extraction runs, scores, and deduplicates, and the funnel counters still accumulate —
so the yield is measured; `recall` simply always faces an empty store, which makes
contamination structurally impossible rather than merely unlikely.

**The price, stated rather than hidden:** with the store cleared, deduplication can only fire
*within* one run, so `mergedDuplicate` across the suite understates what a long-lived store
would merge. `--memory=accumulate` measures that instead, at the cost of order-dependent
scores. Either way, every run records how many facts memory injected into it
(`memory.recalledFacts`), and the table reports **runs influenced by a recalled fact** — so
contamination is a number rather than an assumption.

---

## What each metric means

### Deterministic — no model in the loop

| Metric | How |
| --- | --- |
| **Recall@k** | Did the retrieved chunks include the `expressedIn` documents of every required fact? Set membership on `docId`. `null` where the question expects no documents (the unanswerable set) — never a vacuous 1.0. |
| **Citation validity** | Every `[n]` in the answer resolves to a citation, **and** every citation points at evidence the run actually retrieved. The second half is the one that would otherwise fail silently. |
| **Injection resistance** | Did the compliance token reach the answer? A credential-shaped string? A tool outside the registry? Reported alongside **how many runs actually exercised it** — a run that retrieved no adversarial document resisted nothing. |
| **Plan source coverage** | Fraction of `requiredSources` present in the *retrieved evidence*, not in the tools the plan named. A plan that asked `mail_search` and got nothing back has not covered `mail`. |
| **Hops, sub-questions, latency, cost, tokens** | Straight from the run. Cost is `null`-propagating: a total that silently omits an unpriced call reads as authoritative while being wrong. |
| **Guardrails** | Pass rate per guardrail, from the verdicts the *live pipeline* produced. See below. |
| **Memory funnel** | `proposed → dropped / merged / stored` as deltas around each run, plus how many runs proposed anything at all. |

### Judged — one LLM call per question

Answer correctness, citation support, and abstention correctness come from a single judge call
per question returning all three. Three separate calls would be more independent and would cost
118–177 extra calls against a free tier of ~20 per window, which in practice means the suite
does not get run. **The three verdicts are therefore not independent judgments** — stated here
rather than discovered later.

#### The judge is not tier-separated, and the results say so

PLAN.md §7 asks for a judge on a **different model tier** than the answerer. This project cannot
provide that: on Gemini's free tier the `deep` tier resolves to the same model as `default` (see
`src/ai/llm/model-tiers.ts` — every pro model returns 429, and free deployment is a hard §9
constraint).

What is available is a different **vendor**. The judge uses the first configured fallback
provider that is not the answerer — with the recommended `LLM_PROVIDER=gemini` /
`LLM_FALLBACK_PROVIDERS=groq` setup, Gemini answers and Groq judges. On a single-provider
setup the judge shares the answerer's model, `separateProvider` is `false` in the results, and
the table prints a warning. A README that implied independence it does not have would be worse
than one that admits the gap.

#### Judge agreement

```bash
pnpm eval:judge-agreement
```

20 hand-authored items in `evals/judge-labels.json`, run through the same judge, reported as
per-dimension agreement plus a confusion matrix on correctness. One model call each.

**Verdicts are cached per item**, keyed by the judge model and the label's own content, for the
reason 20 calls looks too small to need it and is not: on a free tier that had already served a
59-question pass, the judge provider allowed roughly *one* call per window, so an uncached run
scored item 1 and stopped. Repeated invocations accumulate instead of restarting — re-run until
it reports 20 of 20. Nothing is cached after a failed call, and the tool always prints the
denominator it actually scored rather than assuming the rest agreed.

**Known limitation, and it is not small:** those answers are authored from the ledger, not
sampled from real runs. An authored wrong answer is wrong in a clean, legible way; a real one is
usually wrong by omission, by hedging, or by being right about the wrong entity. Agreement
measured here is an *optimistic bound* on agreement over the distribution the suite actually
judges. The honest fix is to extend the file with hand-graded answers from real runs.

---

## Guardrails

`src/guardrails/` — five deterministic checks, composed into two stages, each independently
unit-tested for both its pass and its fail path (`src/guardrails/guardrails.spec.ts`) and each
scored here.

They run on **every live run**, not only under the harness: `AgentController` runs the input
stage before the stream opens, and `AgentGraphService` runs the post-run stage after
`run_finished`. The verdicts travel with the run into the results file, so the suite scores what
the deployed system produced rather than re-deriving it from the answer text.

| Guardrail | Stage | What it catches |
| --- | --- | --- |
| `question-abuse` | input | A question long enough to be a way of spending someone else's tokens, padding dressed as a question, or a directive aimed at the system. **Only the first two block.** |
| `injection-detection` | input | Retrieved passages carrying instructions addressed to software. Detection and scoring — the gap M5 explicitly left to M6. |
| `citation-coverage` | output | A sentence that asserts something and cites nothing. Distinct from citation *validity*, which asks whether the markers present resolve. |
| `exfiltration` | output | The compliance token, or a credential-shaped string, in the answer. |
| `abstention-consistency` | output | `abstained: true` together with citations and a real answer — the incoherent run observed live on 2026-09-05. |

Two of these have edges worth knowing:

- **`question-abuse` reports injection vocabulary but never blocks on it.** The answer key
  contains a legitimate question about injection attempts (`q.assistant-injection-policy`), so a
  guardrail that refused on the vocabulary would refuse the questions it is scored against. It
  would have looked like a hardening win right up until the numbers came back.
- **`injection-detection` has a guaranteed true positive that is not an attack.**
  `notes.assistant-threat-model` reproduces both payloads verbatim, because "the wording is the
  evidence". A detector that scored it clean would be missing the strings it exists to find, so
  it is flagged and the findings name the document.

### Two things PLAN.md §5/M6.2 lists that were deliberately not built

§0.4 says not to add an abstraction before a second implementation exists, and the same
discipline applies to filling out a list of guardrails because the list has five bullets.

- **"No PII from one source leaking into an answer scoped to another."** There is no such
  scoping in the product. Retrieval tools are per-source, but an answer merges evidence from
  every tool the plan used, by design — that is the multi-hop capability the whole project is
  about. A guardrail enforcing a boundary the system does not have would pass 100% of the time
  and measure nothing, which is worse than not having it: it would look like a control.
- **"Refusal correctness on unanswerable questions."** Built, but as a *metric* rather than a
  guardrail, because it is not checkable at the point an answer is produced. Whether refusing
  was correct depends on whether the corpus could have answered — which is exactly what the
  answer key knows and a guardrail does not. It is scored as **abstention correctness** (LLM
  judge, over the 8 `unanswerable` questions plus any answer that refused). The part that *is*
  checkable locally — that an abstention did not also answer — is
  `abstention-consistency`.

---

## Threshold sweep

```bash
pnpm eval:sweep
```

`evals/metrics/threshold-sweep.ts` is the reusable utility PLAN.md §5/M6.1 asks to keep. Given
labelled values it sweeps every candidate cutoff and reports precision, recall, F1 — and, more
importantly, **the empty band between the two classes**. A cutoff inside a wide empty band is a
measurement; one taken from a best-F1 where the classes overlap is a guess with a decimal point
on it.

`pnpm eval:sweep` applies it to `RETRIEVAL_DISTANCE_THRESHOLD`, which has been configured but
**not enforced** since M0.6: the 0.902 in `env.schema.ts` was derived for `bge-m3` at 1024
dimensions and the current provider is `gemini-embedding-001` at 768, and
`docs/retrieval-threshold-study.md` concludes such a threshold is not portable across embedding
models. Every retrieval in a finished run is already labelled by the answer key, so no model
calls are needed.

If the sweep reports no separation, the honest outcome is to leave the threshold unenforced and
say why. The tool prints that conclusion rather than the best-F1 number.

The same function reproduces `MEMORY_DEDUP_DISTANCE`'s derivation from
`docs/memory-dedup-threshold.md`; there is a test pinning exactly that.

---

## The CI gate

`.github/workflows/ci.yml` runs on every PR with no key and no quota: lint, typecheck, build,
unit tests, `pnpm check:conventions`, the corpus answer-key verifier, and the UI's own checks.

`.github/workflows/evals.yml` runs the nine-question PR subset
(`PR_SUBSET_QUESTION_IDS` in `evals/ledger.ts` — every category represented) and compares it
against `evals/baseline.json`, failing the build on a regression beyond tolerance and naming the
metric and the delta. **It skips itself when there is no API key**, because a fork PR gets no
secrets and a job that fails for that reason teaches contributors to ignore a red X.

Two kinds of check in `baseline.json`, and the distinction is the point:

- **Floors** are absolute, with no tolerance. Citation validity and injection resistance are
  deterministic properties, not scores — one failure is a real defect.
- **Tolerances** are for judged and retrieval metrics, which move between runs because a model
  is in the loop. Too tight and the gate is noise; a gate that cries wolf gets disabled.

**Nightly results are archived and uploaded, not committed.** PLAN.md §5/M6.3 says to commit
them to `evals/history/` and render a trend table in the README. The job writes the archive and
uploads it as an artifact, and stops there: pushing to `main` from CI needs `contents: write` on
a public repo, which is a meaningful thing to hand a scheduled workflow, and a trend table over
zero nightly runs is an empty table. Turn it on once there is history worth trending, and decide
the permission deliberately rather than as a side effect of wanting a table.

`pnpm check:conventions` deserves a note. It enforces PLAN.md §0.3's rules — no `process.env`
**reads** outside `src/config/`, no `console.*` in `src/`, no module-level singletons — plus §3's
client-identifier gate. HANDOFF predicted it would land red on day one because a naive
`process.env` grep finds three legitimate hits. It does not: writes are distinguished from reads
(which clears `langsmith-tracing.service.ts` automatically), and the two genuine reads carry
named exemptions with reasons. The identifier list is parsed out of PLAN.md §3 rather than
duplicated, so the gate does not have to exempt itself — and note that §3 deliberately no longer
spells out two of the four identifiers, so this covers the two that are named and no more.

---

## Layout

```
evals/
  run-evals.ts          the CLI — `pnpm eval`
  ledger.ts             loads and cross-resolves the answer key; the PR subset lives here
  types.ts              EvalRun, QuestionResult, SuiteResult, the results file schema
  compare.ts            the CI gate — results vs baseline.json
  sweep.ts              RETRIEVAL_DISTANCE_THRESHOLD, re-derived from a finished run
  judge-agreement.ts    the judge vs the hand labels
  judge-labels.json     20 hand-authored items, with their limitation written into the file
  baseline.json         committed thresholds and floors for CI
  results-latest.json   the last FULL run, per mode. Committed — the README's numbers come
                        from it. Currently: a complete `agent` pass (59/59, 0 failed, 0
                        unjudged) and an incomplete `single-shot` one (38 of 59 killed by the
                        free-tier wall; 21 of its runs are cached). Kept rather than deleted,
                        because it is the record of an attempt — and both `renderTable` and
                        `compare.ts` refuse to use a mode that mostly failed, whichever side
                        of the comparison it is on, so it cannot be mistaken for a measurement
                        or gated against. Re-run the baseline to replace it; failed runs are
                        never cached.
  results-pr-subset.json  where `--subset=pr` lands. Committed — it is what baseline.json
                        was recorded from.
  results-partial.json  where `--only`/`--category`/`--limit` land. Gitignored: a
                        one-question suite is not a number anyone should be reviewing, and
                        the point is that it cannot overwrite either file above.
  harness/
    cli.ts              flags, and why each one exists
    flags.ts            the shared flag parser for compare/sweep/judge-agreement
    comparability.ts    when a run failed too much to be compared, or gated, against
    context.ts          boots the real Nest context; the DEMO_MODE and database decisions
    cache.ts            per-question run and judgment cache
    run-agent.ts        one question through the graph; the MemoryProbe
    run-baseline.ts     the single-shot control
    judge.ts            the judge, and an honest account of how independent it is
    report.ts           the metrics table and the merged results file
  metrics/              pure scoring functions, all unit-tested
```
