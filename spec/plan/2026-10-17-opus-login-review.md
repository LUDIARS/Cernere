# Opus review of login entry regressions

Requested by neco. Read-only implementation review completed with `claude-opus-5-5`; no UI execution was claimed. Raw review retained in workspace `.task-artifacts/opus-login-review-retry.json`.

## Disposition

- Medium: buttons re-enabled while asynchronous auth-code exchange was pending. Fixed with explicit delivering state, cleared for retry on handoff error. Interaction test covers the pending and failed handoff states.
- Low: enrollment return path used the raw self redirect. Normalize with existing `resolveSelfRedirectTarget` before constructing the adapter.
- Low/conditional: new-account route does not immediately validate the external service origin. It returns to the local composite login route, which retains the target allowlist check and consent checks before code issuance/delivery. No external redirect is performed by the entry button.
- Low/conditional: legacy `hasAccessRecord` remains exported. Source search found no callers. The new entry uses only `hasLoginCookie` and never this heuristic.
- Informational product observations: first-time choices after cleared cookies and normal returning-user enrollment behavior follow the user's specified flow; no additional options were introduced.
- Test gap: added React interaction tests for no authentication before click, cancellation/retry, unchecked enrollment propagation/persistence, one entry card, and busy state during handoff. The renderer runs under test NODE_ENV and is a dev-only dependency.

Cookie false positive: only exact `cernere_returning=1` is accepted. Empty, unrelated, infrastructure and invalid marker cookies are covered.

Validation: 30 focused tests passed, including the two interaction tests. Physical passkey dialogs and browser visual inspection remain unverified because no browser is connected.
