---
docId: "chat.support-eng.2026-02-10"
source: chat
channel: "support-eng"
date: 2026-02-10
participants: ["person.grace", "person.sofia"]
---

# #support-eng — 2026-02-10

Sofia Marek: Hey Grace, are we any closer to figuring out why Northwind is still missing those replays?
Grace Oduya: Yeah, I tracked it down. Turns out uBlock and a few other ad-blocker filter lists were eating the bundle because of the filename.
Sofia Marek: Ah classic, classic ad-blocker false positive. 
Grace Oduya: Exactly. I just shipped a fix on 2026-02-10 that renamed the Pulse mobile SDK script bundle to avoid ad-blocker filter lists.
Sofia Marek: Amazing, thank goodness. Let's keep an eye on their ingest metrics for the next hour to make sure it clears up.
Grace Oduya: Sounds good, I'll watch the dashboard now.
