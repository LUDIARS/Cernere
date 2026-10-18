# SPEC-CR-NATIVE-COMPOSITE

Requested by neco on 2026-10-18 as part of Cocoiru's minimal app/plugin split.
Source baseline: Cernere 616b6d1. Public package: `@ludiars/cernere-native-composite`.

The native host owns an OS-user-local opaque installation identity and Cernere
authentication. The renderer performs the existing composite passkey flow;
the host exchanges the one-time code and holds the authenticated WebSocket.
Passwords, service secrets, and a parallel identity database are out of scope.
The installation ID does not grant access and is separate from user identity.

Implementation: `packages/native-composite/src/{identity,connection,client}.ts`.
Only identity is persisted; session tokens remain in memory. Explicit destination
origins, redirect rejection, serialized rotation, and lifecycle cleanup are invariants.
Cocoiru consumes the package from its host; no Cocoiru-specific business logic
belongs in Cernere. See the package README for acceptance cases.
