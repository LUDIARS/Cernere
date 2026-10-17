# Browser resume recovery

## Purpose and acceptance
On return to an authenticated Cr page, discard a retained document whose server session may have expired. User explicitly requests recovery across LUDIARS services.

The composite UI SDK exports `installBrowserResumeReload`. Applications install it once for authenticated page lifetime and provide their own connection-health and safe-to-reload predicates. It does not automatically attach through importing login UI.

- Reload on `pageshow.persisted` (history cache restoration).
- Reload on return after 60 seconds hidden, beyond Cr's 30-second ping / 10-second pong allowance.
- Reload after even a short absence if the connection is closed.
- Never reload solely due to a normal initial pageshow, focus, or foreground socket failure.
- Wait until visible and online; coalesce overlapping events into one reload per document.
- Dispose every listener on unmount/account change.
- Cr installs only for authenticated users and excludes login, callback, enrollment, recovery, consent and onboarding routes.
- Native WebAuthn operations share an active-ceremony guard, released on success and rejection. A resume during a ceremony is discarded, not queued to interrupt the subsequent auth handoff.

Reload rebuilds in-memory access tokens through existing device-session refresh and mounts a fresh WS client. It does not auto-start login on an anonymous landing page.

## Adoption scope
This implementation wires Cr and provides the reusable SDK primitive. Other LUDIARS services are not yet wired or deployed by this change. Corpus/Concordia/Actio browser entry points require service-specific lifecycle integration and draft/auth-flow handling. Existing SDK import alone is not evidence of adoption.

## Verification
Lifecycle tests cover normal load, brief healthy absence, closed socket, long absence, history cache, offline recovery, overlapping events, authentication exclusion and cleanup. Real browser suspension and AWS rollout remain separate deployment checks.
