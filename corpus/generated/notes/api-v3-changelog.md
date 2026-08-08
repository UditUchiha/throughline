---
docId: "notes.api-v3-changelog"
source: notes
title: "Pulse API changelog — v3"
tags: ["api", "changelog"]
updated: 2026-03-01
---

# Pulse API changelog — v3

Just pushing this quick note to log the recent release details for the engineering team. 

Pulse API v3 was released on 2026-03-01, adding webhook-based event delivery to the platform. This has been a long-requested feature from our enterprise clients who rely on real-time alerts without having to poll the endpoint constantly. 

The rollout went smoother than the [[Aurora migration]] last quarter, mostly thanks to the prep work the backend crew did during the last sprint. We should make sure the [[Helios]] documentation is updated by the end of the week so customer success has the right payload examples to share. 

If anyone runs into payload delivery drops or signature verification issues on the new webhook endpoints, drop a note in the engineering channel.
