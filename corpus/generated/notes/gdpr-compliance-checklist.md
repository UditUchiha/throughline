---
docId: "notes.gdpr-compliance-checklist"
source: notes
title: "GDPR compliance checklist"
tags: ["compliance", "policy"]
updated: 2025-11-22
---

# GDPR compliance checklist

Review our current data handling policies ahead of the upcoming internal audit. Most of the technical safeguards are already covered by our work on [[Data Retention]] and [[Server Security]], but we need to ensure all documentation is up to date for the privacy team.

Here is the standard run-down we should verify across all active services:

- **Data Minimization:** Confirm that we are only collecting payload fields strictly necessary for debugging and performance monitoring. Masking rules for sensitive user input (like passwords or payment details) should be checked via [[Masking Rules]].
- **Right to Erasure:** Verify that our automated deletion scripts for user session data and error logs execute reliably within the required timeframe. Check the cron jobs handling the [[Storage Buckets]].
- **Consent and Notice:** Ensure our public-facing documentation accurately reflects what data Pulse stores, how long it persists, and [[Third-Party Subprocessors]] involved in infrastructure hosting.
- **Access Controls:** Limit internal database access using role-based permissions. Only designated engineering leads should be able to query raw production payloads, as outlined in [[Internal Security Policy]].

Let's sync up during next week's standup to see who is tackling each section. If anyone needs to reference older notes, check the [[Archive Index]] or ask in the privacy channel.
