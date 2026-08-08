---
docId: "notes.aurora-migration-risk-assessment"
source: notes
title: "Aurora migration — risk assessment"
tags: ["infra", "aurora-migration", "risk"]
updated: 2026-04-20
---

# Aurora migration — risk assessment

Hey everyone, dropping some notes here following our sync on the database infrastructure. As we push toward the [[Helios]] release next month, we need to make sure our underlying data layers can handle the spike in throughput without dropping events or spiking error rates on Pulse.

Looking closely at the timeline and our current test runs, the main identified risk for the Aurora migration is replication lag under the increased session-write volume expected after the Helios launch. 

Since Pulse relies heavily on real-time session replay ingestion alongside continuous error tracking and performance analytics, even a brief delay in replica sync could cause temporary inconsistencies in the dashboard or back up our ingestion queues. We saw some minor latency spikes during the last load test when writes doubled, which points right to this bottleneck.

Action items for this week:
- Run another stress test simulating 3x normal write load against an [[Aurora migration]] staging cluster.
- Check parameter tuning on the writer and reader instances to see if we can optimize the replication stream.
- Coordinate with the frontend squad so we handle any potential read-after-write quirks gracefully in the UI if lag does creep in during peak hours.

Let's keep discussions rolling in the main channel. I'll update this note once we have the new benchmark numbers back from staging.
