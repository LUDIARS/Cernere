# SPEC-EMBEDDED-COMPOSITE-001: Hosted Composite inside the service

## SPEC-EMBEDDED-COMPOSITE-001

GLab must not navigate its top-level window or open a popup to log in. The Composite SDK exports CompositeLoginFrame, embedding Cernere's current /composite/login card. The rounded card, cookie-derived choices, explicit login click, checked enrollment option, help and recovery placement remain the same implementation as /login. Registration, enrollment, consent and recovery navigate inside the frame.

The iframe delegates WebAuthn get/create and recovery camera access only to its source origin. Its sandbox does not permit popups or top navigation. WebAuthn keeps the Cernere RP origin; the server additionally rejects cross-origin ceremonies without an explicitly allowed topOrigin. Existing challenge, RP ID, signature and user verification are unchanged.

The SDK accepts one authCode only from the exact Cernere origin and the mounted frame window. The child checks the existing server target allowlist before sending to its parent; consent uses its server-validated outcome. No wildcard postMessage is permitted. Exchange stays on the host backend. Recovery carries only a local return path.

Rollout: merge/deploy Cernere and update the consuming Corpus/GLab submodule references and GLab mount through their own reviews. No assumption that publishing the SDK automatically updates consumers. No automatic popup fallback on unsupported embedded WebAuthn. Actual embedded authentication requires browser validation; unit tests do not prove platform support.

WebAuthn embedding contract: https://www.w3.org/TR/webauthn-3/#sctn-permissions-policy
