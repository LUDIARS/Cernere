---
task: Explicit login entry and cookie-dependent enrollment choices
project: Cr
kind: implementation
created: 2026-10-17
memory_links: []
---

Human instructions: do not start authentication when opening Cr; use the subsequently specified cookie/no-cookie entry flow, default checked smartphone enrollment, and two recovery options.

Implementation contract and acceptance: ../feature/explicit-login-entry.md.

Preserve service destination validation, consent and authentication boundaries. No authentication credential is stored in the presentation cookie. Existing administrator-issued recovery links remain valid.
