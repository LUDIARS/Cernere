---
task: pc-passkey-enrollment
project: Cernere
kind: implementation
created: 2026-10-16
memory_links:
  - spec/feature/pc-passkey-enrollment.md
---

# Offer PC passkey registration before optional account federation

neco requested a path to register a passkey on PCs that otherwise keep relying on smartphone authentication. The same-account enrollment path should precede optional federation settings.

## Acceptance

- Login and continuation screens expose an explicit local registration entry.
- A desktop external-authenticator login may offer enrollment, without claiming to know that local credentials are absent.
- Reuse authenticated passkey registration and fresh action proof; do not create an unrelated account or consume a service auth code internally.
- Preserve the original service destination and run its normal consent/authorization checks after registration or skipping.
- Unsupported local authenticators and cancellation remain recoverable, with no success claim.
- Federation remains optional after local registration; account and service data remain unchanged.

See the linked feature specification for source evidence and verification cases. Progress belongs to the linked task/review system, not this file.
