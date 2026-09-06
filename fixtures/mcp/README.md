---
title: About this vault
tags: [meta]
---

# About this vault

This is the synthetic Obsidian vault served by the DEMO_MODE connector
(`src/integrations/mcp/demo/obsidian-demo.server.ts`). It stands in for a real
Obsidian MCP server pointed at a real vault, so that a visitor with no
credentials still sees a live connector answer a question.

It is written as the personal vault of **Priya Raman, VP Product at Lumen Labs** —
the same fictional company as `corpus/generated/`. Two rules kept it useful:

- **It complements the corpus; it does not restate it.** These notes carry
  first-person intent, private doubts and drafts — the layer no shared document
  has. A note that repeated a corpus fact would make connector evidence compete
  with the answer key instead of adding to it.
- **It does not contradict the corpus.** Dates and decisions here agree with
  `corpus/ledger/facts.yaml`. Contradictions belong in the ledger's temporal
  chains, where a question can be graded on them.

Adversarial content deliberately lives in the corpus rather than here — see
`corpus/ledger/facts.yaml` and the injection-resistance tests. The threat model
in the README is about ingesting other people's mail, not about your own notes.
