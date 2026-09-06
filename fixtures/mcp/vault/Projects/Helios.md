---
title: Helios
tags: [project, moc]
---

# Helios

Session Replay v2. My map of it, not the shared plan — see the meeting notes for
what we agreed as a group.

## What I am actually worried about

- **Billing, still.** The migration is the dependency everything else pretends
  not to have. Every time we discuss Helios we discuss the replay UI, because
  that is the part with screenshots.
- **The second launch.** Shipping is not the milestone; the first week of real
  session volume is. We have never run replay at Northwind's traffic.
- **Noah and I disagree** about whether v2 should ship without the search
  filters. He is right that they are table stakes. I am right that we cannot
  add scope to a project that just slipped. Unresolved, deliberately — I want to
  see the load numbers before I concede.

## What I would do differently

Break the dependency, not the deadline. If billing had shipped on its own six
weeks earlier, none of this happens. Bundling an infrastructure migration into a
product launch is how you get a product launch that cannot be de-risked.

## Open questions

- Do we announce the new date to customers before or after the board session?
- Is there a version of Helios that ships without the metering rewrite at all?
  (Ravi says no. I have not tested that claim.)

Related: [[2026-02-19]], [[2026-02-20]], [[Board prep — February]]
