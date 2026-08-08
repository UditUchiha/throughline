---
docId: "notes.pulse-terminology-glossary"
source: notes
title: "Pulse terminology glossary"
tags: ["glossary", "product"]
updated: 2025-09-15
---

# Pulse terminology glossary

This reference note covers standard terminology used across the [[Pulse]] codebase, UI components, and internal documentation. Keeping these definitions clear helps align product, engineering, and support teams.

A **session** represents a single continuous period of user activity on a monitored application. It begins when a user loads the page and ends after a period of inactivity or when they close the browser tab. Sessions tie together all related [[telemetry]], errors, and network requests.

A **replay** is the visual reconstruction of a user session within the [[Pulse]] dashboard. Instead of recording a traditional video file, the system captures DOM mutations and user interactions, allowing us to render a high-fidelity, interactive playback of what the user experienced.

An **event** is a discrete data point captured during a session, such as a click, a custom application log, a page view, or a network request. Events form the foundational timeline stream that can be filtered and searched within the [[analytics engine]].

A **funnel** is a sequence of specific steps or events that users are expected to complete in order. Funnel analysis helps us measure conversion rates and identify drop-off points across different user journeys. 

For more details on how these primitives integrate with [[Helios]] ingestion pipelines or our upcoming [[Aurora migration]], check the relevant architecture RFCs.
