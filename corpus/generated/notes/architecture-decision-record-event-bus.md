---
docId: "notes.architecture-decision-record-event-bus"
source: notes
title: "ADR: introducing an internal event bus"
tags: ["architecture", "adr", "infra"]
updated: 2025-12-01
---

# ADR: introducing an internal event bus

We are seeing increasing tight coupling between our ingestion pipeline services, specifically around how [[Pulse]] session payload processing triggers downstream error clustering and performance metric recalculations. Point-to-point HTTP calls are becoming brittle and harder to debug when downstream workers experience temporary backpressure.

To decouple these workflows, we are proposing the introduction of an internal event bus utilizing a lightweight message broker pattern. This will allow producers to emit lifecycle events—such as session recording finalized or error payload ingested—without needing to know which consumers are listening.

Initial prototyping suggests using a Redis Streams-backed approach for simplicity, keeping operational overhead low given our current team size. This aligns with our general preference for keeping infrastructure components straightforward to maintain.

Decision drivers include improving fault tolerance, enabling easier addition of new asynchronous processors (like future analytics aggregators), and reducing latency in the primary ingestion path. 

Consequences of this change will include adopting a standardized event schema registry, updating our local development [[Docker Compose]] setup to spin up the broker automatically, and establishing conventions around idempotency for all consumer handlers. We will run a two-week trial with a single non-critical pipeline before rolling the pattern out broadly across other [[Lumen Labs]] services.
