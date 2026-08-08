---
docId: "notes.customer-health-score-rubric"
source: notes
title: "Customer health score rubric"
tags: ["support", "rubric"]
updated: 2025-10-05
---

# Customer health score rubric

When we look at [[customer health score rubric]], we want to keep things simple enough that the team actually uses it during weekly syncs without drowning in spreadsheets. A healthy account usually shows steady, organic usage of core [[Pulse]] features like session replay and error tracking, without sudden cliffs in daily active users. 

On the flip side, red flags usually start with silence. If a champion stops opening support tickets or logging into the dashboard entirely, that is often a louder warning sign than an angry email about a bug. We also track integration stability—specifically [[error tracking]] volume spikes and sudden drops in data ingestion rates, which usually signal that their engineering team broke the SDK snippet or changed something on their end.

We group accounts into three basic tiers:
- **Green:** Active daily use, growing seat count [[Aurora migration]], low error rates, and responsive to check-ins.
- **Yellow:** Flat usage, sporadic logins, or recent turnover among their main internal advocates. Time to loop in [[Helios]] for a quick proactive audit.
- **Red:** Significant drop in event volume, unresolved billing or technical blockers, or total ghosting. 

The goal isn't to create a rigid, automated score that we blindly trust, but rather a starting point for our account reviews. Every customer’s workflow is a bit different, so gut check from the engineering and support side always overrides a raw metric. If someone has low login frequency because they only pull reports at the end of every sprint, that is totally fine as long as they are getting [[performance analytics]] value when they do log in.
