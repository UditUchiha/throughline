---
name: add-fact
description: Add or change a fact in the corpus answer key — ledger entry, document assignment, question, regeneration, and verification, in the order that keeps the eval suite honest. Usage - /add-fact <what the fact should say>.
disable-model-invocation: true
---

# Add a fact to the corpus

`$ARGUMENTS` describes the fact to add or change. If it is empty or vague, ask what the fact
should assert and which storyline it belongs to before touching anything.

Four files have to change together, **in this order**. Ground truth is authored before prose
(PLAN.md §6) — writing the document first and back-filling the fact produces an answer key
graded against itself, which measures nothing.

> Writing to `.env`, `pnpm-lock.yaml`, and `database/*.db` is blocked by a PreToolUse hook, and
> every corpus edit triggers automatic verification. Expect that verification to run and read
> what it says.

## Step 0 — Make the fact verifiable

`scripts/corpus-generate.ts` verifies a fact survived generation by checking that **literal
tokens** from its statement appear in the document: ISO dates (`2026-04-21`), dollar amounts
(`$2.1M`), multipliers (`4x`), and names of people already in `entities.yaml`.

A statement with none of those cannot be verified. "The team was unhappy with the rollout" will
pass verification while expressing nothing checkable. Write statements that pin a date, a
number, or a named person.

Then check the two failure modes that cost the most later:

- **Is it one fact?** If the statement bundles an event *and* its later resolution
  ("reported on X, fixed by Y, no bounty paid"), split it now. No single document can express
  all three — the earlier ones had not happened when it was written. This is exactly the
  `fact.security-finding-2` defect described in PLAN.md's status section.
- **Does it supersede something?** If it changes a value the corpus already states, set
  `supersedes: fact.<old-id>` and leave the old fact in place. The stale value must stay
  retrievable — that is what makes the temporal-trap questions work.

## Step 1 — `corpus/ledger/entities.yaml`

Every person named in the statement must exist here, or the verifier will never check that
name. Add under `people:` if missing:

```yaml
  - id: person.<firstname>
    name: <Full Name>
    role: <Role>
```

Internal email convention is `firstname@lumenlabs.io`. External contacts are deliberately *not*
entities — facts never depend on an outsider's exact identity.

## Step 2 — `corpus/ledger/facts.yaml`

```yaml
  - id: fact.<kebab-case-id>
    statement: >
      <One assertion, containing at least one date, amount, or entity name.>
    expressedIn: [<docId>, ...]
    supersedes: null   # or fact.<old-id>
```

Keep it in its storyline's commented block. Every `expressedIn` id must resolve to a document
in Step 3 — the generator hard-fails on a dangling id.

## Step 3 — `corpus/ledger/documents.yaml`

Either assign the fact to an existing document or add a new one. Assigning to an existing
document is preferred: it keeps corpus size flat and makes retrieval harder in a realistic way.

Before assigning, check the document could plausibly express the fact:

- Its `date` is on or after the events asserted. **A message cannot report what has not
  happened yet.**
- Its `from` person would know this.
- Its `to` audience is one you would actually state it to, in full, rather than allude to.

Add the fact id to that document's `factIds`, and extend its `brief` to instruct the fact
explicitly — the brief is the prompt the generator receives; a fact not in the brief only lands
by luck and vanishes on the next regeneration.

New documents follow the shape of their source list:

```yaml
mail:
  - docId: mail.thread-<topic>.msg-<n>
    threadId: thread-<topic>
    subject: <subject>
    from: <name>@lumenlabs.io
    to: [<name>@lumenlabs.io]
    date: <YYYY-MM-DD>
    factIds: [fact.<id>]
    brief: >
      <What this message says, naming the fact's date/amount/person explicitly.>
```

`chat` entries are channel-days (`channel`, `date`, `participants`); `notes` are Obsidian-style
(`title`, `tags`, `updated`) and may use `[[wikilinks]]`. `factIds: []` means a deliberate noise
document — do not "fix" those.

## Step 4 — `corpus/questions.yaml`

**A fact with no question is never evaluated.** Add at least one:

```yaml
  - id: q.<kebab-case-id>
    question: "<Natural question a colleague would ask.>"
    category: single-hop | multi-hop | temporal | distractor | unanswerable
    requiredFacts: [fact.<id>, ...]
    requiredSources: [mail | chat | notes, ...]
    minHops: 0
    expectedAbstention: false
    referenceAnswer: "<Answer stating the fact's values.>"
```

- `requiredSources` must be the **actual** source types of the `expressedIn` documents. A
  multi-hop question whose facts all live in chat does not test cross-source fan-out.
- `minHops` is *additional* retrieval rounds beyond the first: `0` for single-hop, `≥1` when
  the answer needs facts the first retrieval would not surface together.
- Every claim in `referenceAnswer` must trace to a listed `requiredFacts` statement.
- Category targets (PLAN.md §6): ~12 single-hop, ~20 multi-hop, ~8 temporal, ~8 distractor,
  ~8 unanswerable. Check the current distribution before adding, and prefer the category that
  is short. Adversarial/injection is deferred to M5 — do not add those yet.

## Step 5 — Regenerate only what changed

```bash
pnpm corpus:generate --dry-run --only=fact.<id>   # inspect the prompts first
pnpm corpus:generate --only=fact.<id>             # needs GEMINI_API_KEY
```

`--only=` matches a source name, a docId prefix, or a fact id, and regenerates every document
touching it. Never regenerate the whole corpus for one fact — it costs quota and churns
committed files that did not need to change.

If `GEMINI_API_KEY` is not set, stop and tell the user. Do not hand-write the document prose as
a substitute: hand-editing is a documented, permitted workflow (PLAN.md §12.2), but it is for
adding voice and mess to existing prose, not for faking a generation step.

## Step 6 — Verify, then read the diff

```bash
pnpm corpus:generate --verify-only    # all 169+ docs, no model calls, ~6s
git diff --stat corpus/generated/
```

If verification flags the new fact, **check whether the assigned document could plausibly
express it at all** before assuming the generator misbehaved. If it could not, the fix is in the
ledger — split the fact or reassign it — not in a re-roll of the prose.

Read the regenerated documents. Confirm the fact reads naturally rather than being bolted on,
and that no *other* document silently changed.

## Step 7 — Hand back

Report: the fact id, the documents it landed in, the question(s) added, the verification result,
and the files to commit (`corpus/ledger/*.yaml`, `corpus/questions.yaml`, and the regenerated
`corpus/generated/**`). `corpus/.generation-report.json` is gitignored — do not commit it.

For a deeper check of chronology, supersedes chains, and category coverage, suggest running the
`corpus-ledger-auditor` subagent.
