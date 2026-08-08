---
docId: "mail.thread-security-disclosure-openredirect.msg-1"
source: mail
threadId: "thread-security-disclosure-openredirect"
subject: "Open redirect in OAuth login flow"
from: "anon.researcher2@protonmail.example"
to: ["security@lumenlabs.io"]
date: 2025-11-12
---

# Open redirect in OAuth login flow

Hey team,

Just wanted to flag a security issue I noticed while testing the Pulse app today, 12 November 2025. There's an open-redirect vulnerability in the OAuth login flow that lets an attacker bounce users off to an external domain after authenticating. 

I know this is a separate report from the stuff usually handled through the main channels, but wanted to drop it here for the record. 

Cheers,
Anon
