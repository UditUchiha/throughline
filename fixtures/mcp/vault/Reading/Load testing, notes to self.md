---
title: Load testing, notes to self
tags: [reading, notes]
---

# Load testing, notes to self

Not about any particular project. Collected while trying to work out why we keep
being surprised.

- A load test at the end of a project is a **release gate**. A load test
  throughout is a **design constraint**. Only the second one changes what gets
  built.
- Testing at "expected volume" tests the plan. Testing at 4x tests the system.
  The multiplier is the whole experiment; without it you have measured your own
  assumptions.
- Connection pools are where optimistic architecture goes to die. Everything
  looks fine until concurrency exceeds the pool, and then the failure is not
  gradual — it is a cliff, and it always looks like a database problem.
- The useful question after a failed load test is not "can we fix it" but "when
  could we have known". Ours: January.

Things to steal:

- Publish the load profile before the test, so the result cannot be reframed
  afterwards.
- Have someone who did not build it write the pass criteria.
