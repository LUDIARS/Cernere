# Add device after smartphone login

User instruction: unify the action as 「端末を追加する」, remove the initial enrollment checkbox, and offer 「次から表示しない」 on the post-login device-add screen.

- The login card starts authentication only on click, without an enrollment choice.
- On desktop, hybrid/cross-platform login offers device addition only when neither the registered-passkey marker nor the separate browser-local dismissal preference is present.
- The dismissal cookie is a display hint, never proof of registration or authentication. It lasts one year in this browser. Explicit device addition remains accessible from settings.
- The enrollment page offers a skip action returning to a validated same-origin destination. Existing service target/consent checks remain authoritative.
- QR approval and distinct device enrollment remain unchanged. No existing credential is copied or removed.
- Acceptance checks: no initial checkbox; first-time PC prompt; registered/dismissed/mobile suppression; dismissal does not set registration marker; skip does not create an enrollment request; existing QR approval/save flow retained.

Actio lookup was unavailable during implementation; task status remains unknown until the authoritative service can be read.
