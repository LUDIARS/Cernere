# Explicit login entry

Human requirement: Cr must not begin authentication immediately on opening.

## Behavior

- Both `/login` and `/composite/login` require an explicit action.
- Preserve the original rounded, bordered 400px card, surface background, 2rem padding and centered title. Fit within narrow viewports.
- Clicking either login action runs authentication inside the same card; never mount the legacy CompositeLogin screen or navigate to the legacy continue menu. Cancellation/errors leave the chosen entry controls available for retry, preserving the enrollment checkbox.
- With a first-party cookie, show `パスキーでログイン` and run the existing normal flow on activation. Infrastructure cookies are excluded; HttpOnly secrets are never exposed. Successful authentication stores a non-secret `cernere_returning` cookie to select this presentation on subsequent visits. The hint never grants authorization.
- Without a cookie, show `はじめて使う` with `新規アカウントで登録します`, and `スマホでログイン` with a checked-by-default `この端末のパスキーを登録して連携` checkbox.
- First-time use navigates to `/start` with the original local return destination. Smartphone login requests hybrid authentication and bypasses silent SSO. Checking enrollment adds a local passkey to the authenticated account; unchecking preserves normal service handoff without an enrollment detour. Federation remains optional after enrollment.
- Before activation, neither WebAuthn nor the login session hook (including silent SSO and auth-code handoff) starts.
- Activation mounts the existing authentication flow, preserving origin validation, consent, redirects and passkey enrollment.
- `アカウントを復旧する` is a link to `/recover`. The recovery selection has `リカバリー用のQRから復元する` (existing QR recovery at `/recover/qr`) and `管理者に連絡する` (contact instructions). Existing operator recovery links containing `#token` still work.
- Returning from enrollment or onboarding requires login activation again before SSO handoff.
- Existing authenticated application sessions and the embedded SDK defaults are unchanged.

## Acceptance

- Initial rendering in self and composite modes invokes no authentication session hook.
- The login button starts the existing authentication component; destination query parameters are retained.
- The entry layout fits a narrow viewport without a fixed-width panel.
- Cookie/no-cookie rendering, default checkbox, recovery destinations and both enrollment choices have regression coverage.
