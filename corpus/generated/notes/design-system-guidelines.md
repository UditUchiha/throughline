---
docId: "notes.design-system-guidelines"
source: notes
title: "Design system guidelines"
tags: ["design", "guidelines"]
updated: 2025-11-01
---

# Design system guidelines

When building and maintaining our UI components for the [[design system]], consistency is key to keeping the [[Pulse]] interface clean and intuitive. Whether you are working on performance charts, session replay controls, or standard forms, always start with our foundational tokens for spacing, typography, and color rather than hardcoding values.

For layout structures, rely on standard grid containers and flexbox utilities defined in [[core tokens]]. Avoid creating custom layout wrappers unless absolutely necessary for a specialized visualization widget. When styling interactive elements like buttons, dropdowns, and toggles, make sure to utilize the built-in states for hover, focus, and disabled modes to maintain proper accessibility standards across all views.

Accessibility is a shared responsibility. Every new component needs to support keyboard navigation out of the box and pass standard contrast checks. If you are introducing a new pattern that does not currently exist in the library, propose it during our weekly [[design sync]] before merging any production code. Document your component's props clearly with TypeScript interfaces and include basic usage examples so other engineers can adopt it quickly without needing direct guidance.
