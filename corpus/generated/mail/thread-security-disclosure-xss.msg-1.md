---
docId: "mail.thread-security-disclosure-xss.msg-1"
source: mail
threadId: "thread-security-disclosure-xss"
subject: "Security disclosure — stored XSS in custom annotations"
from: "anon.researcher1@protonmail.example"
to: ["security@lumenlabs.io"]
date: 2026-02-25
---

# Security disclosure — stored XSS in custom annotations

Hello Lumen Labs Security Team,

I am writing to report a security vulnerability I discovered in the Pulse dashboard today, February 25, 2026. 

Specifically, I found a stored Cross-Site Scripting (XSS) vulnerability within the custom-annotation feature. When creating a new custom annotation, user-supplied input in the description field is insufficiently sanitized before being stored and rendered back to other dashboard users in the main session view. 

To reproduce this issue, you can submit an annotation payload containing standard script tags or event handlers—for example, injecting `<script>alert(document.cookie)</script>` into the annotation name or notes. When another user loads the annotated session replay, the malicious script executes within the context of their session.

Please let me know if you need any additional details, request logs, or further proof-of-concept steps to verify this behavior. I will hold off on public disclosure until your team has had a chance to investigate and patch the issue.

Best regards,

anon.researcher1@protonmail.example
