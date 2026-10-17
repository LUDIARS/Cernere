---
task: Recover retained browser pages across LUDIARS
project: Cr
kind: bugfix
created: 2026-10-17
memory_links: []
---

User request: reload retained browser pages after returning when keepalive or WebSocket sessions have expired, across LUDIARS services.

Acceptance: authenticated Cr page lifecycle recovery, no initial auto-login, no native passkey interruption, no offline/duplicate reload loops, reusable policy, explicit service adoption and deployment evidence.

Implementation specification: `spec/feature/browser-resume-recovery.md`.

Cross-service rollout must verify each browser entry point and its unsaved-form/authentication behavior. Adding an SDK export alone does not complete the cross-service request. Initial inspected consumers: Concordia `web/src/main.tsx`, Actio `frontend/src/main.tsx`, Corpus `public/src/app.ts`. Concordia and Corpus do not currently depend on the composite UI package; Actio declares an older ^0.3.0 package. These integrations require separate reviewed changes and package distribution, not sibling-path dependencies.

References: https://developer.mozilla.org/ja/docs/Web/API/Window/pageshow_event and https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event
