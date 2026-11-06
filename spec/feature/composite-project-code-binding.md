# Project-bound Composite authorization codes

## SPEC-COMPOSITE-PROJECT-PKCE

The accepted contract is [the 2026-10-30 design](../plan/2026-10-30-authcode-service-binding.md).
Service code issuance binds the project, registered origin, subject and an S256 challenge. Exchange requires
the same project's current credential and the initiating browser's verifier. Codes expire after 60 seconds,
are consumed once across every exchange endpoint and never contain an access or refresh token.
Old unbound codes, plain PKCE and absent verifiers are rejected. Current project configuration, user/device
revocation and service consent are checked again at exchange. A service receives only its 15-minute
PASETO token. Self and kiosk exchanges accept only their respective purpose.
Ordinary user-token login and Composite self completion accept only authenticator-signed Cernere
origins. Registered service origins are valid only for service/kiosk assertions; a supplied HTTP Origin
header cannot promote a service assertion into a global Cernere session. Ordinary login uses
`login-begin`; Composite uses `composite-login-begin`. The one-use, versioned challenge records
the completion purpose, project/PKCE binding, exact handoff fields and expected signed origin.
Completion cannot change any of them. Service assertions accept only the destination project's origin
or the hosted Cr ceremony's origin, never the union of all registered projects. Cross-origin service
frames additionally require the destination's signed `topOrigin`, checked after signature verification;
the legacy missing-topOrigin option does not weaken this project check.

If a service login leads to PC enrollment, the browser starts a separate self ceremony before obtaining
a Cr session. It does not reuse or change the service challenge. Signup and credential registration
continue to require Cr's own signed origin. Old unbound in-flight login challenges expire/reject at cutover.

The browser owns the verifier; popup and frame completion require the expected origin, source and state.
The login control stays busy from initiation through backend exchange completion, closes its owned popup
on every terminal path and releases listeners/timers on unmount. Redirect state is single use and bounded
by a finite creation time. Consent continuations preserve the same project binding and caller state.

New service sessions still require the service's own resource authorization. This code exchange contract
does not itself authorize a sensitive read or important operation; those additionally require the shared
guard, a bound service session and a current Cernere decision.
