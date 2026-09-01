# Composite Passkey Review Regressions

- Date: 2026-09-02
- Status: fixed in working tree
- Area: composite authentication / WebAuthn
- Severity: high — rate-limit bypass and auth-code redirect exposure were possible

## Summary

PR #1204 introduced regressions in the embedded passkey flow. A project could control the value used for unauthenticated rate limiting, a crafted self-login redirect could resolve off-origin, the login UI was briefly interactive before destination validation completed, and fingerprint recovery could loop without a bound. A completed signup could also be reported as a generic failure if subsequent auth-code issuance failed.

## Evidence

- `server/src/ws/project-dispatch.ts` forwarded payload `clientIp` into the passkey rate-limit context.
- `frontend/src/lib/composite-auth-handoff.ts` accepted any string beginning with `/` except `//`; `/\\evil.example` resolves cross-origin in URL parsing.
- `frontend/src/hooks/useCompositeLoginSession.ts` initialized `blockedReason` empty and validated the target asynchronously.
- `frontend/src/lib/composite-ws-session.ts` immediately resent the same failed fingerprint after every retryable server error.
- `server/src/http/passkey-handler.ts` committed user/passkey creation before issuing the composite auth code.
- Project WebSocket command errors reflected unexpected passkey handler messages, including potential persistence details.

## Regression Context

The prior hosted login kept target validation and UI gating in one page component. Extracting session, handoff, and WebSocket responsibilities preserved most behavior but opened timing and trust-boundary gaps that the two newly added relay/origin tests did not cover.

## Cause

Untrusted service metadata was treated as a rate-limit identity, path-prefix validation was used instead of URL-origin validation, the asynchronous gate lacked a pending state, and retry recovery had neither delay nor limit. Signup persistence and auth-code issuance span PostgreSQL and Redis, so a post-commit issuance failure cannot be rolled back atomically by the current storage contract.

## Fix Requirements

- Scope project-WS ceremony limits only by the authenticated `projectKey` and discard claimed IP metadata.
- Resolve self redirects against the current origin and require exact origin equality.
- Keep all authentication controls hidden until destination validation and silent SSO finish.
- Delay and cap fingerprint retries, clearing timers on every close path.
- If auth-code issuance fails after signup commit, state that the account exists and direct the user to sign in with the registered passkey.
- Accept only HTTP(S) entries as WebAuthn expected origins.
- Allowlist client-safe passkey errors at the project WebSocket boundary and suppress unexpected internals.

## Verification

- Added regression coverage for spoofed `clientIp`, rate-limit identity selection, backslash/network-path self redirects, non-HTTP WebAuthn origins, and internal error suppression.
- Tests were not run in this Revisor pass because the session was restricted to file reads and edits.
- Browser runtime verification must exercise delayed destination validation, WebAuthn signup/login, and forced fingerprint rejection.

## Follow-up

- A future auth-code outbox or single-store issuance design can make account creation and handoff issuance fully atomic across PostgreSQL and Redis.
