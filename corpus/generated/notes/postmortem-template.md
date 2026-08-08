---
docId: "notes.postmortem-template"
source: notes
title: "Postmortem template"
tags: ["template", "postmortem"]
updated: 2025-08-05
---

# Postmortem template

When something breaks in [[Pulse]] production, we want to make sure we capture the context while [[Engineering]] has it fresh in mind. This template is designed to keep our postmortems consistent without feeling overly bureaucratic. Feel free to copy this into a new note whenever we need to review an unexpected incident.

**Incident Summary**
* **Date:** 
* **Author:** 
* **Status:** Draft / Review / Complete
* **Impact:** (Briefly describe user-facing symptoms, duration, and percentage of traffic affected. Link to any relevant [[Status page]] updates.)

**Timeline**
* *HH:MM* – First alert fired or customer report received.
* *HH:MM* – Investigation started by the [[On-call rotation]] team.
* *HH:MM* – Mitigation applied (rollback, feature flag toggle, etc.).
* *HH:MM* – Services fully recovered and verified.

**Root Cause Analysis**
What actually happened under the hood? Did this touch [[Session replay]], [[Error tracking]], or [[Performance analytics]] infrastructure? Avoid blaming individuals; focus on systemic factors, missing tests, or edge cases in our [[CI-CD pipelines]].

**Lessons Learned**
* What went well during the response?
* What was unexpectedly difficult?
* Were our runbooks up to date?

**Action Items**
* [ ] Task 1 (Owner, due date)
* [ ] Task 2 (Owner, due date)

Once you fill this out, drop a link in the main channel so the rest of the team can review. We usually spend a few minutes discussing recent write-ups during our next sync.
