---
docId: "notes.support-macros-reference"
source: notes
title: "Support macros reference"
tags: ["support", "reference"]
updated: 2026-03-24
---

# Support macros reference

Here are a few quick text snippets we can drop into Intercom or Zendesk when tickets get repetitive. Saves everyone from typing the same thing ten times a day, especially when [[Support Triage]] is backed up.

**Issue: Replay showing blank white screen**
> Hey there! Thanks for reaching out about this. Usually, a blank screen in a session replay means there is a strict Content Security Policy (CSP) blocking our recording script or canvas elements from capturing the DOM. Could you check if your headers are blocking third-party worker scripts or eval? We have a quick guide on this in the [[Documentation Hub]].

**Issue: Where to find API keys**
> Morning! You can generate or roll your API keys by heading over to [[Settings and Billing]], clicking on the *Project Settings* tab in the left sidebar, and scrolling down to the *API Access* section. Let me know if you run into any permission roadblocks there.

**Issue: SDK bundle size concerns**
> Great question on performance overhead. Our snippet is heavily optimized and weighs in at under 15kb compressed. It loads asynchronously via [[CDN Setup]] so it won't block your main thread or impact your Core Web Vitals. If you need a deeper dive into our tech stack, take a peek at [[Architecture Overview]].

Feel free to tweak these as needed, but try to keep the tone friendly and direct. If you come up with a new macro that gets used more than three times in a week, add it here so the rest of the [[Customer Success]] crew can [[Knowledge Base Updates|sync up]].
