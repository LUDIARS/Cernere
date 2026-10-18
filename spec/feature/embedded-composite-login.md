# SPEC-EMBEDDED-COMPOSITE-001: Hosted Composite inside the service

## SPEC-EMBEDDED-COMPOSITE-001

GLab must not navigate its top-level window or open a popup to log in. The Composite SDK exports CompositeLoginFrame, embedding Cernere's current /composite/login card. The rounded card, cookie-derived choices, explicit login click, checked enrollment option, help and recovery placement remain the same implementation as /login. Registration, enrollment, consent and recovery navigate inside the frame.

The iframe delegates WebAuthn get/create and recovery camera access only to its source origin. Its sandbox does not permit popups or top navigation. WebAuthn keeps the Cernere RP origin. Every hosted document enforces CSP frame-ancestors from the backend's exact Composite allowlist; failure to obtain a valid policy serves 503 with frame-ancestors 'none'. This covers nested ancestors and registration/recovery navigation. Level 2 clients may omit topOrigin. If supplied, signed topOrigin must be an exact allowed origin; malformed crossOrigin/topOrigin and an empty allowlist are rejected. Existing challenge, RP ID, signature and user verification are unchanged.

Deployment prerequisite: activate and verify the frontend CSP middleware before activating the backend compatibility change. Static deployments must provide the same HTTP response header (a meta element cannot enforce frame-ancestors). Do not enable compatibility on an unprotected frontend.

`CERNERE_WEBAUTHN_LEGACY_FRAME_POLICY=true` enables missing-topOrigin compatibility only after header verification. It defaults to false, so a backend code update alone retains the old protection.

Embedded Composite displays only the rounded card, without the full-height outer background or padding. Its document background is transparent; standalone login keeps its existing layout.

Adding a passkey at `/passkeys/register` uses two explicit actions: prepare (existing-key authorization and server challenge), then save on this device. The save click calls WebAuthn creation before any asynchronous preparation or network request, retaining transient user activation in cross-origin frames. Preparation never creates a credential automatically. Cancellation or expired preparation requires preparation again; prepared operations are single-use and expire before the server challenge. Required action proofs, platform-only selection and finish verification remain enforced.

The SDK accepts one authCode only from the exact Cernere origin and the mounted frame window. The child checks the existing server target allowlist before sending to its parent; consent uses its server-validated outcome. No wildcard postMessage is permitted. Exchange stays on the host backend. Recovery carries only a local return path.

Rollout: merge/deploy Cernere and update the consuming Corpus/GLab submodule references and GLab mount through their own reviews. No assumption that publishing the SDK automatically updates consumers. No automatic popup fallback on unsupported embedded WebAuthn. Actual embedded authentication requires browser validation; unit tests do not prove platform support.

WebAuthn embedding contract: https://www.w3.org/TR/webauthn-3/#sctn-permissions-policy
