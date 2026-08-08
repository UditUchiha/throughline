---
docId: "notes.engineering-onboarding-runbook"
source: notes
title: "Engineering onboarding runbook"
tags: ["runbook", "onboarding", "eng"]
updated: 2025-09-01
---

# Engineering onboarding runbook

Welcome to Lumen Labs! This runbook covers the standard setup process for getting your local development environment ready to work on [[Pulse]] and our associated services. 

First, make sure you have requested access to our primary GitHub organization through [[IT Operations]]. Once your SSH keys are configured, clone the main repositories. Most of our backend services run locally via Docker, so verify that your Docker Desktop allocation is set to at least 4GB of RAM before spinning up the [[Docker Compose]] stack.

For database migrations and local testing, check the [[Database setup]] guide. You will need to install Node.js (version matching `.nvmrc`), Go, and our internal CLI tool, `lumen-ctl`. 

Once your environment variables are populated from [[1Password]], run `make setup` in the root directory. This will install dependencies, configure pre-commit hooks, and seed your local PostgreSQL instance with dummy data so you can test error tracking and performance analytics modules locally.

If you hit any snags during setup, reach out in the `#eng-onboarding` Slack channel or ping your assigned buddy. Welcome aboard!
