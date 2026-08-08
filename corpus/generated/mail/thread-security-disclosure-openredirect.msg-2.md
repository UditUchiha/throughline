---
docId: "mail.thread-security-disclosure-openredirect.msg-2"
source: mail
threadId: "thread-security-disclosure-openredirect"
subject: "Re: Open redirect in OAuth login flow — resolved, no bounty"
from: "marcus@lumenlabs.io"
to: ["ravi@lumenlabs.io", "ben@lumenlabs.io"]
date: 2025-11-18
---

# Re: Open redirect in OAuth login flow — resolved, no bounty

Closing this one out for the record.

Ben Holt picked up the open-redirect issue in the OAuth login flow and shipped the fix
earlier this week — we now validate the redirect target against an allowlist rather than
trusting the parameter, so the bounce-to-external-domain behaviour the reporter described
is no longer possible.

On the question of a payout: no bounty was paid here. The finding fell outside the scope
of our bounty program as it stood at the time, and auth-flow redirects weren't listed as an
in-scope class. I've replied to the reporter to explain that and thank them for the
write-up. Worth revisiting the scope document before the next disclosure comes in — I'd
rather widen it deliberately than have this conversation again under pressure.

Marcus
