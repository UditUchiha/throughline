---
docId: "notes.northwind-support-postmortem"
source: notes
title: "Postmortem: Northwind missing session replays"
tags: ["postmortem", "support", "northwind"]
updated: 2026-02-09
---

# Postmortem: Northwind missing session replays

We spent the morning digging into the ticket [[Northwind Retail]] opened about gaps in their [[session replay]] data. Things looked fine on our end during initial checks, but once we pulled the raw edge logs, the picture cleared up. 

It turns out that Northwind Retail's missing session replays were caused by an ad-blocker false-positive flagging Pulse's mobile SDK script as a tracker. Popular consumer list blocklists had recently updated their heuristic rules, which unfortunately caught our ingestion endpoint in the crossfire for a subset of end-users running strict browser extensions or device-level protection. 

The good news is that no data was actually corrupted or dropped on our servers; the payloads simply never made it out of the clients' devices. 

To prevent this from biting us again with other enterprise accounts, we need to fast-track our [[SDK proxy]] routing options and review our [[domain masking]] recommendations. I've updated [[Runbook - Adblock Mitigation]] with the specific signature patterns we found in this case so support can spot it faster next time. 

Let's sync during tomorrow's [[engineering standup]] to prioritize the domain fallback work.
