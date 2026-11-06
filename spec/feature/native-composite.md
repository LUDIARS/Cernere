# SPEC-CR-NATIVE-COMPOSITE

Requested by neco on 2026-10-18 as part of Cocoiru's minimal app/plugin split.
Source baseline: Cernere 616b6d1. Public package: `@ludiars/cernere-native-composite`.

The native host owns an OS-user-local opaque installation identity and one
service's opaque session. The renderer performs the existing composite passkey
flow; the host owns PKCE/state, and the service backend exchanges the one-time code.
Passwords, service secrets, and a parallel identity database are out of scope.
The installation ID does not grant access and is separate from user identity.

Implementation: `packages/native-composite/src/{identity,client}.ts`.
Only identity is persisted; session tokens remain in memory. Explicit destination
origin, redirect rejection, serialized operations, and lifecycle cleanup are invariants.
The 2026-10-30 contract removes direct Cr token exchange/refresh and the Cr WebSocket
lease from the native host. `/api/auth/native/{exchange,logout}` belongs to the configured
service. Its session uses the shared operation guard and the service's own data authorization.
Cocoiru consumes the package from its host; no Cocoiru-specific business logic
belongs in Cernere. See the package README for acceptance cases.
