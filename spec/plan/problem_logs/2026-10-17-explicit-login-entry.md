# Authentication starts on opening Cernere

- Report: neco requested that opening Cr must not immediately log in.
- Cause: CompositeLoginPage mounted useCompositeLoginSession and the auto-starting passkey UI immediately. Existing composite sessions could also hand off without an explicit click.
- Fix: defer mounting the existing authentication flow until the login button is activated. Preserve registration/recovery entry links and validated return targets.
- Specification: spec/feature/explicit-login-entry.md.
- Verification: initial-render regression for self/composite routes; frontend production build. Browser interaction and physical authenticator verification require a connected browser.
