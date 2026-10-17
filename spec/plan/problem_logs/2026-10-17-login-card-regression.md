# Login entry design and undefined legacy screen regression

- User reports: original rounded card was removed; clicking passkey login displays an undefined legacy screen.
- Cause: new LoginEntry omitted original card styling, and CompositeLoginPage swapped it for CompositeLogin after activation.
- Fix: preserve LoginEntry for the complete ceremony, mount a status-only LoginAttempt after explicit activation, and restore the original card surface/border/radius/padding. Keep the defined cookie choices and enrollment preference.
- Regression coverage: original card markup and no legacy controls in authentication/cancellation status.

## Returning-cookie false positive

- User also reported passkey login appearing without a login cookie.
- Confirmed implementation defect: every readable cookie except a small infrastructure denylist counted as returning; e.g. `theme=dark` and `CF_Authorization` triggered passkey-only presentation.
- Fix: exact allowlist for `cernere_returning=1`; empty, unrelated, invalid-valued and prefixed cookies must return false. Added regression cases.
- User requested an Opus implementation review in addition to Revisor. Review evidence is retained in workspace task artifacts.
