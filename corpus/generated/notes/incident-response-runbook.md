---
docId: "notes.incident-response-runbook"
source: notes
title: "Incident response runbook"
tags: ["runbook", "incidents", "oncall"]
updated: 2025-10-15
---

# Incident response runbook

When an alert fires in [[Datadog]] or PagerDuty, the engineer on call must acknowledge it within fifteen minutes. Severity one issues—those involving total data loss, core pipeline failure, or widespread customer-facing outages—require an immediate bridge in [[Slack]] and direct notification to the engineering lead.

For severity two issues, which affect non-critical features or a limited subset of users, response expectations are slightly more relaxed, though investigation should begin during standard working hours without undue delay. Severity three tickets are logged for minor UI glitches or isolated bugs and are handled during normal sprint planning.

The primary goal during any active event [[Incident Triage]] is mitigation first, root-cause analysis second. Once services are stable and data integrity is verified, the team transitions to drafting an internal post-mortem document. This write-up should outline the timeline of the event, contributing factors, and concrete action items to prevent recurrence. These action items get added directly to our [[Jira Backlog]] and prioritized for the upcoming sprint cycle.

Communication [[Status Page Comms]] is critical when external users are impacted. The designated incident commander coordinates with support and product teams to ensure timely updates go out, keeping our customers informed while engineering focuses entirely on remediation.
