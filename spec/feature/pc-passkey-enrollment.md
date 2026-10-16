# PC passkey enrollment before optional federation

- Request: neco, 2026-10-16, offer registration on PCs without a passkey so users do not authenticate with a smartphone on every visit; federation may follow registration.
- Domain: web-frontend; existing authentication registration and action-proof APIs remain authoritative.
- Specification: SPEC-PC-PASSKEY-ENROLLMENT

## Flow

Login and the continuation menu offer `/passkeys/register?return=<local path>`. If signed out, the page requests a Cernere self login using another device, preserving the registration destination. Once signed in, an explicit button calls existing `passkeyRegister` for the same account with `authenticatorAttachment: platform`. Existing fresh passkey action proof, server verification, credential exclusions and user verification remain unchanged. No new account or federation is created.

On desktop interactive login, a WebAuthn response with `authenticatorAttachment: cross-platform` offers enrollment before returning to a service. This includes external security keys; it is not evidence that the PC has no passkey. Missing attachment metadata and mobile logins keep the normal flow. Enrollment-initiated login does not recursively wrap its own destination.

For that offer, the adapter obtains a Cernere-only auth code (without a service target), exchanges it once for the account session, and navigates to enrollment without delivering the consumed code. After completion or skipping, the original local login URL resumes normal destination validation, silent SSO, service consent and access checks. No service code is stored while waiting for enrollment.

The registration page checks platform-authenticator availability for presentation only. An unsupported device, cancelled ceremony or rejected registration is not shown as success. Retry and skip remain available. A shared/public PC should skip. After success, the user can return to the original service or open optional federation settings.

## Acceptance and evidence

- Preserve the existing account and service records; never infer credential absence from a cancelled login or from an account-wide credential list.
- Registration must require user interaction and existing server authorization. Request platform registration so the new credential is not accidentally saved on the phone again.
- Return targets must remain same-origin local paths, including malformed slash/backslash inputs.
- Desktop external-authenticator login, self login, composite popup/redirect, consent-required return, unsupported platform, cancellation, retry, skip, and mobile/platform-authenticator login are review cases.
- Navigation regression tests: `server/tests/frontend/passkey-enrollment.test.ts`.
- Anatomia deterministic plan identified existing `default/web-frontend` and `default/authentication`; no new domain required. Pf project `01M3FVMF9VM713AVRRWE44WMCP` resolved to Cernere; the checked-in account-federation design §4/§6 is the referenced flow specification.
- Genius CLI query failed on response-schema mismatch (`decidedBy`); no judgment card was treated as evidence.
- No Actio task link returned for this session at implementation time. Existing federation task describes a different scope and was not reused.

## Scope

This adds same-account local credential enrollment before optional federation. It does not reorder the existing new-account signup ceremony or relax federation approval, action proofs, user access, or service consent. Tests and device interaction have not been executed by this session; Revisor verification and actual Windows Hello/Touch ID testing remain required.
