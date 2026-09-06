# Retrieval threshold study

This records a piece of tuning work done on an earlier, client-specific version of this
project, before the retrieval-quality eval data was removed (§M0.4 of `PLAN.md`). The method
and aggregate numbers below are the author's own work product and are safe to publish; the
underlying query/document text was a real customer's support-ticket knowledge base and is
not included.

## The problem

A RAG pipeline needs to decide, per query, whether the best-matching retrieved chunk is
close enough to trust — versus flagging the response for human review. That decision is a
single distance cutoff (`RETRIEVAL_DISTANCE_THRESHOLD`): below it, the closest chunk is
treated as confident grounding; above it, retrieval is treated as too weak to trust blindly.
Picking that cutoff by feel is exactly the kind of parameter that quietly rots — it was tuned
once for one embedding model and chunk size, then silently wrong after either changed.

## Method

A 30-item golden set of support queries was used:
- **22 queries** with a known-relevant knowledge-base section (a real question a customer
  would ask, with a human-verified correct answer location).
- **8 queries** that were spam or off-topic — no relevant section exists.

For each query: embed it, run k-NN retrieval, record the **distance of the single closest
retrieved chunk** (lower distance = more similar). Then sweep every candidate cutoff at the
midpoint between two consecutive observed distances, and pick the cutoff that maximizes:

```
separation accuracy = (relevant queries kept below cutoff + irrelevant queries flagged above cutoff)
                       ────────────────────────────────────────────────────────────────────────────
                                              30
```

This is a small, mechanical piece of work, but it is exactly the kind of number a RAG project
usually just asserts without measuring. The sweep logic lives on in `evals/run-evals.ts`
(generalized for the agent's eval suite from M6 onward) and is reusable for tuning any scored
cutoff, not just this one.

## Result (embedding model: `bge-m3`, 1024-dim, chunk size 700 words)

| | n | min | p50 | p90 | max |
|---|---|---|---|---|---|
| Relevant queries (best-chunk distance) | 22 | 0.718 | 0.775 | 0.847 | 0.892 |
| Off-topic/spam queries (best-chunk distance) | 8 | 0.912 | 0.949 | 1.036 | 1.042 |

The two distributions do not overlap — every relevant query's closest chunk was nearer than
every off-topic query's closest chunk. The sweep found **0.902** as the cutoff, achieving
**100% separation accuracy** (30/30) on this set: all 22 relevant queries correctly kept as
grounded, all 8 irrelevant queries correctly flagged for review.

Supporting numbers from the same run: intent-classification accuracy was 83.3% (25/30) and
retrieval hit-rate@5 (did the correct KB section appear anywhere in the top 5 chunks, not
just as the single best) was 95.5%.

## The finding that made this worth writing down

The threshold in place before this study was **0.8**, carried over from an earlier
configuration: a 768-dimension English-only embedding model with 300-word chunks. When the
embedding model changed to a 1024-dimension multilingual model (the knowledge base was ~96%
German) and the chunk size changed to 700 words to hold a full distilled Q&A pair as one
chunk, the *scale* of the distance metric shifted too — but nothing re-validated the
threshold against it. At 0.8, several relevant queries in the new configuration would have
sat above the cutoff and been wrongly flagged as weakly grounded, purely because the
threshold was a leftover from a different embedding geometry.

This is the general failure mode: **a distance threshold is not portable across embedding
models or chunking schemes**, even when it "still basically works" on spot-checks. It has to
be re-derived from data whenever either changes. The eval harness carried forward into this
project's `evals/` (§M6) exists to make that re-derivation a `pnpm eval` away rather than a
manual re-tuning exercise — and, per M1.2 of `PLAN.md`, this project now also *detects and
fails fast* on an embedding-model/index mismatch outright, rather than allowing a stale
threshold to keep running silently.

## Honest caveats

- **n=30 is small.** A clean, non-overlapping gap on 30 queries is encouraging but is not
  strong statistical evidence; it could close under a larger, noisier sample of real traffic.
- This was evaluated on one language-heavy domain (predominantly German, ecommerce support
  intents). The specific numbers do not generalize to other domains — the *method* does.
- The raw golden-set queries and results files (`golden-set.json`, `golden-set.de.json`,
  `results-*.json`) were removed from this repository because they were derived from a real
  customer's ticket history. Only the method and the aggregate statistics above are kept.

---

## 2026-09-06 — re-derived on this corpus, and the answer is "do not enforce it"

The caveats above turned out to matter. M6's eval harness re-ran the method against the corpus
this project actually ships, and it does **not** reproduce the clean gap.

**Method.** `pnpm eval:sweep` reads a finished 59-question run out of
`evals/results-latest.json`. Every retrieval in it is already labelled by the answer key — a
chunk is *relevant* when its `docId` is one of the `expressedIn` documents of a fact the
question requires — so no new labelling, no embedding calls, and no judge. It then sweeps every
midpoint between adjacent observed distances.

**Sample.** 471 retrievals across the questions that have expected documents: **74 relevant,
397 not.** (Questions with no expected documents — the unanswerable set — are excluded: "not
one of the expected documents" is not the same as "irrelevant" when nothing was expected.)

**Result.**

| | |
| --- | --- |
| Embedding model | `gemini-embedding-001` @ 768d |
| Best achievable F1 | **0.551**, at distance **0.4854** |
| …its precision / recall | 0.495 / 0.622 |
| Separation band | **none — the two classes overlap** |

At the best cutoff, half of what would be kept is irrelevant and nearly 40% of the relevant
passages would be discarded. There is no interval containing no observations with the relevant
retrievals on one side and the irrelevant on the other, which is exactly the structure the
original study relied on.

**Conclusion: `RETRIEVAL_DISTANCE_THRESHOLD` stays unenforced**, and the reason is now a
measurement rather than a portability argument. `evals/metrics/threshold-sweep.ts` reports the
separation band *before* the best F1 and prints this conclusion rather than the number, so a
later reader cannot mistake "the best cutoff available" for "a derived cutoff".

**Why the two studies disagree** is worth stating rather than glossing. The original was 30
hand-labelled queries over a single-domain support knowledge base, where relevant and
irrelevant were genuinely far apart in embedding space. This corpus is deliberately the
opposite: one company, ten interlocking storylines, ~100 documents of pure noise written in the
same voice about the same people and projects. A distractor here is *topically adjacent by
construction* — that is the point of the `distractor` and `temporal` question categories — so
the embedding distance between "the right Helios document" and "a different Helios document"
is small. A corpus built to defeat naive similarity retrieval will not hand you a clean
similarity cutoff.

The same sweep function is what `docs/memory-dedup-threshold.md` used, and there it *did* find
a clean band. Same method, same code, opposite answer — which is the argument for measuring
each cutoff separately rather than carrying one over.
