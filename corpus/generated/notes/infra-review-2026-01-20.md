---
docId: "notes.infra-review-2026-01-20"
source: notes
title: "Infra review — 2026-01-20"
tags: ["infra", "meeting-notes"]
updated: 2026-01-20
---

# Infra review — 2026-01-20

Good turnout today for the sync. Mostly went over the usual [[Pulse]] backend metrics, but we spent a good chunk of time diving into the current database setup and why everyone keeps getting paged at 3 AM. 

The main pain point continues to be manual maintenance on the self-hosted instances. Between disk space alerts, routine patching, and replication lag [[Helios]], the team is spending way too much time babysitting infrastructure instead of shipping features for [[Pulse]]. 

After looking at a few options, the team decided at the 2026-01-20 infra review to migrate the primary Postgres database from self-hosted to a managed provider (Aurora), to reduce on-call burden. 

Moving to Aurora should take a massive weight off the [[Aurora migration]] project backlog. We'll get automated backups, easier scaling, and—most importantly—fewer middle-of-the-night alerts for the engineering rotation. 

Will spin up a staging cluster next week to benchmark the read/write performance against our current setup. If the numbers look good, we'll draft a proper cutover timeline and share it with the rest of the crew.
