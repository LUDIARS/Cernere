# Explicit login entry

Human requirement: Cr must not begin authentication immediately on opening.

## Behavior

- Both `/login` and `/composite/login` require an explicit action.
- Preserve the original rounded, bordered 400px card, surface background, 2rem padding and centered title. Fit within narrow viewports.
- Clicking either login action runs authentication inside the same card; never mount the legacy CompositeLogin screen or navigate to the legacy continue menu. Cancellation/errors leave the chosen entry controls available for retry, preserving the enrollment checkbox.
- Only with the exact `cernere_passkey_registered=1` cookie, show `パスキーでログイン` and run the existing normal flow on activation. Unrelated cookies (including Cloudflare Access, preferences and analytics) and invalid marker values never count; HttpOnly secrets are never exposed. Only successful Cr passkey registration (signup-finish, register-finish, or confirmed recovery activation) stores this non-secret hint. Session storage never sets it. Legacy cernere_returning cookies are ignored. Pending pairing/recovery and cancelled or failed registration do not set it. The hint never grants authorization.
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
- Enrollment checkbox and its full label occupy one horizontal line. Override global input width/padding with a fixed 1rem checkbox and use responsive card side padding; do not rely only on flexShrink. This requirement follows the second reported checkbox-layout regression on 2026-10-17.
- Display `スマホでログインする場合、` immediately above the single-line checkbox label `この端末のパスキーを登録して連携`. Associate the context through aria-describedby.
- Place the recovery link at the lower right with 3rem separation from the login controls. Place an expandable help explanation at the upper right; opening help does not begin authentication or navigate away.
- Cookie/no-cookie rendering, default checkbox, recovery destinations and both enrollment choices have regression coverage.
