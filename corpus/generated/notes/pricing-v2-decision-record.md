---
docId: "notes.pricing-v2-decision-record"
source: notes
title: "Decision record: usage-based pricing"
tags: ["pricing", "decision-record", "product"]
updated: 2026-01-14
---

# Decision record: usage-based pricing

We had the sync this morning to finally wrap up the endless billing discussions and get everyone aligned on the shift away from the old [[Pulse pricing (2025 launch)]] model. It's been clear for a while that charging by the seat just doesn't align with how customers actually use the platform, especially as teams share logins or automate testing pipelines. 

After reviewing the final numbers and the [[Aurora migration]] timeline, usage-based pricing was approved on 2026-01-14 to replace seat-based pricing, effective 2026-04-01. 

Under the new model, customers will be billed per session recorded. This means our billing will directly scale with the volume of data they send to [[Pulse]], which better matches our underlying infrastructure costs and provides a much cleaner entry point for smaller teams who were previously blocked by minimum seat tiers. 

The product and engineering squads need to make sure the metering infrastructure is fully baked before the April rollout, and customer success should start drafting communication touchpoints for our existing accounts next week. We'll also need to update the [[Helios]] integration docs so the new telemetry metrics map correctly to the usage counters.
