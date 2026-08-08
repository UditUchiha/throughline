---
docId: "notes.product-roadmap-h1-2026"
source: notes
title: "Product roadmap — H1 2026"
tags: ["product", "roadmap"]
updated: 2026-01-10
---

# Product roadmap — H1 2026

Here is our working outline for the upcoming half. The general focus for H1 2026 is on stabilizing our core data ingestion pipelines and improving overall dashboard responsiveness for larger teams. 

We want to make sure the core experience feels snappy before rolling out any major visual overhauls. A lot of this ties back to the ongoing work in [[Aurora migration]], which should give us the database performance headroom we need to support heavier query loads.

On the feature side, we are currently tracking a few key initiatives. First, we need to finalize the scope for [[Helios]] so the design team can start exploring mockups by late Q1. Second, engineering has [[API v3]] on the docket as a background effort, primarily focused on cleaning up deprecated endpoints and improving developer documentation rather than rewriting the whole contract overnight. 

Customer feedback from the last few user interviews highlighted that session filtering still feels a bit clunky when dealing with high-volume noise. We should schedule a quick sync with support next week to pull some recent examples of those failing queries so the frontend squad has realistic test cases.

As usual, this is a living document and will likely shift a bit once we lock in engineering capacity during our next planning retro. Feel free to drop comments or questions directly in the thread.
