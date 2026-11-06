# Composite service session and operation authority

## SPEC-COMPOSITE-OPERATION-GUARD

The service supplies its own explicit `ResourceOperation.risk`. The shared SDK rejects a missing or
mismatching classification, so a sensitive GET cannot be relabeled as a basic read by a stale Cr
configuration. Risk is included in the one-use proof binding and revalidated at consume; policy drift
between authorize/consume denies execution. The current decision is passed to the resource callback.

This extends the accepted 2026-10-30 project-bound code contract. It retains the registered hub URL,
PASETO `user_for_project` token and 15-minute lifetime; it does not adopt the older draft's different TTL
or audience. Cernere is the authority for identity, revocation, consent and declared operation permission.
The service owns its direct user session and authorizes its own target data.

- A service backend authenticates with its current project credential and presents the exchanged project
  token. It binds the grant to SHA-256 of one randomly generated opaque service session ID. Redis
  set-if-absent fixes this binding; only an identical active binding is idempotent. Logout keeps a revoked
  tombstone until the original expiry, so the grant cannot be rebound after logout.
- `schema_definition.service_operations` is administrator-owned. Each exact action declares `read`,
  `sensitive_read` or `important` and required consent permission keys. Sensitive reads include GET.
  Missing classifications, malformed policy and generic identity-only permission for a sensitive or
  important action are denied. The browser cannot select the action or risk classification for a route.
  Service-local data uses `service_operation.<action/group>` consent keys. Their caps are derived only
  from administrator-owned operation policies; the service cannot self-grant a new operation permission.
  They do not declare or copy the service's domain data into Cernere's user_data tables.
- Every protected operation checks the current project generation/configuration, signed token purpose,
  grant, service session binding, source user/device revocation, federated identity and current consent.
  No positive authorization cache or notification delivery is a substitute for that live check.
  New Composite code issuance and exchange always require an actual service consent decision, including
  projects whose older integration still has `consent_mode=off/warn`. Other authentication contracts do
  not change. A consent revision change invalidates existing service grants, including revoke/regrant.
  Login/session metadata returns `email: null` unless the current `identity_claim.email` grant allows it;
  basic identification alone does not disclose the email field.
- Authorization creates a 30-second one-time permit using the existing action-proof store. Its resource
  is the digest of version/project/grant/user/session/action/resource/content digest/request ID. Consume
  rechecks current policy and all bindings before atomically consuming that same permit.
- The shared SDK consumes the permit, then invokes the mandatory current resource-authorization callback
  immediately before the service operation. The service must use its own transaction/locking where needed.
  Cernere permit consumption and the service database are not a distributed transaction. A failed or
  unknown operation is never automatically repeated; existing service idempotency rules decide recovery.
- HTTP timeouts, malformed responses, absent state, missing policy or unavailable authority fail closed.
  User revocation is observed on the next live guard call even if all push notifications were missed.

The session policy depends on typed `createIfAbsent/read/compareAndRevoke` commands.
The Redis adapter owns `SET EX NX`, reads and one fixed compare-and-tombstone Lua
transaction with `KEEPTTL`. Policy callers and fixtures cannot provide script source.
Binding/tombstone tests exercise that narrow atomic contract; adapter contract tests
also assert exact Redis arguments, strict success replies and propagated failures.

Backend endpoints under `/api/auth/service/`: `bind`, `check`, `revoke`, `authorize`, `consume`.
Every endpoint requires the project bearer credential and `{ projectToken, sessionBinding }`.
The last two additionally require `{ action, resource, contentDigest, requestId }`, and `consume` requires
the permit. Only the service backend handles the project token and project credential.

The Composite backend configuration is `{ cernereUrl, projectKey, clientId, clientSecret }`.
It opens no admission WebSocket, issues no local JWT and needs no `jwtSecret`. The separate
service-adapter package retains its separate admission API; it is no longer a Composite dependency.
Disposal aborts outstanding authority requests and clears the cached project credential.

Acceptance covers competing bindings, same-binding retry, tombstones, missing/changed policies, sensitive
GET classification, wrong project/user/session/action/resource/body/request ID, revocation between
authorize and consume, parallel permit replay, authority outage, denied service resource authorization
and an unknown service execution result without retry.
