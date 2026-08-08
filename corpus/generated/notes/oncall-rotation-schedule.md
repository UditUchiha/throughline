---
docId: "notes.oncall-rotation-schedule"
source: notes
title: "On-call rotation schedule (reference)"
tags: ["oncall", "infra", "reference"]
updated: 2026-03-01
---

# On-call rotation schedule (reference)

Just keeping this as a quick reference for how we usually split up [[Engineering]] duties and handle support escalations for [[Pulse]]. Nothing set in stone here since people swap shifts all the time in Slack, but this is the general baseline we try to follow.

Usually, primary on-call rotates weekly right after our Monday sync. Whoever is primary handles incoming alerts, customer-reported frontend glitches, and any sudden drops in session replay ingestion. If [[Aurora migration]] tasks get too noisy or a deploy breaks something major, secondary steps in to help triage.

For urgent errors or database spikes, check the pinned alerts channel before paging anyone directly. We try to keep things async unless production is actively throwing a 500 error loop. If you need to trade a week with someone, just update the spreadsheet and ping the team lead so everyone knows who's holding the pager.
