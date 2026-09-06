# Where `MEMORY_DEDUP_DISTANCE` comes from

Long-term memory deduplicates by embedding a candidate fact and comparing it to what is
already stored: at or below a distance threshold the candidate is treated as a *restatement*
and merged into the existing fact (bumping `access_count`) instead of inserted.

That threshold is a number someone has to choose, and choosing it by feel is how
`RETRIEVAL_DISTANCE_THRESHOLD` ended up documented as "not currently enforced" — see
[`retrieval-threshold-study.md`](./retrieval-threshold-study.md), whose conclusion is that a
distance cutoff **is not portable across embedding models**. So this one was measured.

## Method

Nine text pairs, hand-labelled into three groups: restatements of one fact, facts that are
related but genuinely distinct, and unrelated text. Both halves of each pair were embedded
with the configured provider in a single request, and the distance between them computed
directly.

`sqlite-vec`'s `vec0` uses **L2** by default, which is the metric `vec_memory_facts` inherits,
so L2 is the column that matters. Cosine is shown alongside because it is what most people
expect — and because `gemini-embedding-001` truncated to 768d returns vectors that are **not
unit-normalised** (measured norm ≈ 0.585), so the usual `L2 = sqrt(2 · cosine)` identity does
not hold here. Reading a cosine figure as though it were the stored distance would be off by
roughly a factor of two.

## Result — `gemini-embedding-001`, 768 dimensions, 2026-09-05

| Group | Pair | L2 | cosine |
| --- | --- | --- | --- |
| restatement | identical text | 0.0000 | 0.0000 |
| restatement | "approved the Helios launch date" / passive voice | 0.0865 | 0.0108 |
| restatement | "prefers concise answers" / "likes short, brief answers" | 0.1929 | 0.0541 |
| restatement | "told when evidence is weak" / "know when evidence is thin" | 0.2716 | 0.1057 |
| restatement | "works on the Helios project" / "is on the Helios team" | 0.2759 | 0.1104 |
| **distinct** | "prefers concise answers" / "prefers answers with citations" | 0.4051 | 0.2407 |
| **distinct** | "works on Helios" / "works on the Pulse observability stack" | 0.4630 | 0.3117 |
| unrelated | "works on Helios" / "prefers concise answers" | 0.5127 | 0.3818 |
| unrelated | "prefers concise answers" / "the billing migration failed load testing" | 0.5881 | 0.4987 |

> **This table is also the source for `MEMORY_RECALL_DISTANCE` (0.49).** That threshold asks a
> different question — not "is this the same fact?" but "is this fact about what was asked?" —
> so it takes the *other* empty band, between related-but-distinct (0.463) and unrelated
> (0.513). Note that band is 0.05 wide with two points on each side, against 0.13 and five
> below for the dedup number: it is the best available evidence, not equally strong evidence.
> Re-derive both if the embedding model changes, and widen the sample in M6.

Restatements top out at **0.276**. The closest genuinely distinct pair sits at **0.405**.
Nothing falls between them, so the choice is any value in that band; **0.35** takes it with
0.074 of margin below and 0.055 above.

## What the two failure modes cost

They are not symmetric, which is why the threshold sits nearer the middle than the top of the
restatement range:

- **Too high** merges "prefers concise answers" with "prefers answers with citations" into one
  fact, and the loser is gone — there is no record that two different things were ever said.
  The nearest distinct pair is 0.405, so anything at or above that is actively wrong.
- **Too low** stores a duplicate. The consolidation job merges near-duplicates on its next
  pass, and until then the cost is one redundant row and a slightly diluted funnel number.

Recoverable beats unrecoverable, so err low.

## When to redo this

Whenever `EMBEDDING_MODEL` or `EMBEDDING_DIMENSIONS` changes. The number above describes one
model at one size and means nothing for another — that is the whole finding of the retrieval
study, and this file exists so the same lesson is not learned twice.

The probe is nine embeddings in one request and takes seconds. Embed both halves of a set of
labelled pairs, print the L2 distances, and look for the empty band.
