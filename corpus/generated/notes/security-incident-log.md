---
docId: "notes.security-incident-log"
source: notes
title: "Security incident log — stored XSS (2026-02-25)"
tags: ["security", "incident-log"]
updated: 2026-03-01
---

# Security incident log — stored XSS (2026-02-25)

Quick follow-up on the bug bounty submission from yesterday regarding the session replay renderer. The security researcher who reported the stored XSS vulnerability was paid a $1,500 bounty, approved by Ravi Anand. 

We had a brief sync with the [[Core Engineering]] team to ensure the payload sanitation was rolled out properly across all active [[Pulse]] endpoints. Everything looks stable now, and the automated regression suite passed without any issues. 

Just dropping this here for the [[Security Audits]] vault so we have a clean paper trail for the upcoming compliance check. Ravi signed off on the payout this morning through [[Finance]], so the ticket is fully closed out on our end.
