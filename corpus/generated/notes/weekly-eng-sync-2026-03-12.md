---
docId: "notes.weekly-eng-sync-2026-03-12"
source: notes
title: "Weekly eng sync — 2026-03-12"
tags: ["meeting-notes", "eng"]
updated: 2026-03-12
---

# Weekly eng sync — 2026-03-12

Had our usual Thursday catch-up today. Attendance was decent considering a few folks are out dealing with lingering colds or appointments. 

Frontend squad mentioned they are still chipping away at the lingering accessibility quirks in the navigation drawer. Nothing blocking, just tedious CSS cleanup. They are hoping to wrap that up before jumping into the next batch of component library upgrades. 

Backend folks are mostly heads-down on database maintenance and cleaning up old query logs. Mentioned that query latency has been sitting at a very healthy baseline all week, which is great. They also touched on the ongoing [[Aurora migration]], noting that staging environments are behaving as expected so far. No real drama there, just slow and steady validation.

We spent a good chunk of time talking about developer experience and how long local test suites take to run on older machines. Marcus brought up setting up a quick shared cache to speed things up, so we’ll probably spin up a small [[Helios]] spike next week to see if it actually moves the needle. 

Nothing else major on the docket. Reminder to everyone to keep PR descriptions descriptive and try to merge before Friday afternoon so things don't sit over the weekend.
