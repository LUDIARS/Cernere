# One-operation service delegation

## SPEC-COMPOSITE-DELEGATION

This supplements the accepted 2026-10-30 project/PKCE cutover. It does not revive the old hub user-token
contract. Auth codes still live 60 seconds and service grants at most 15 minutes. A downstream delegation
is a separate **30-second, one-use** opaque capability backed by the existing ActionProofStore.
It introduces neither a custom signature format nor a reusable downstream user token.

The source calls `POST /api/auth/service/delegate` with its current project credential, bound scoped
grant/session, target project and registered audience, action, method, canonical pathname+query,
resource (exactly that path), body digest, semantic-header digest and UUID request ID. Cr checks the
original user/device/session, source project generation/audience, current source consent and the
administrator-owned `delegate.<targetProject>.<targetAction>` service operation. It also checks the
active target project, its registered hub_url, target operation, effective target permissions and explicit
target consent. Source and target risk classifications must agree; unclassified reads, including GET,
are denied. A request ID cannot be minted twice for the source grant, including unknown outcomes.

The source sends `Authorization: Cernere-Delegation <opaque token>` and `X-Cernere-Request-Id` to the
target, using exactly the prepared body/URL/semantic headers. It never forwards its local session,
Cr project credential, scoped grant token or a global access/refresh token. The capability is distinct
from Bearer login and cannot become a local browser/native session or a re-delegation source.

The target computes the actual envelope using its own route classification and calls
`POST /api/auth/service/consume-delegation` with its own current project credential. Cr matches the
saved target project/generation/audience and the entire request envelope, then rechecks the original
source grant's live user/device/session, project generation, both services' permissions/consent, target
consent revision and risk. The existing proof GETDEL permits one successful consume, even concurrently.
Metadata alone cannot authorize a replay. Cr returns only a target-scoped operation decision and identity.
The target must run its **latest target-data authorization** immediately before execution through the SDK
callback; the Cr decision cannot replace ownership, membership, role or record-state checks.
The target must explicitly supply its local risk classification. The SDK rejects disagreement with
Cr's consumed decision; neither an undefined local classification nor a stale central read label permits
a locally classified sensitive read or important operation.

`CompositeDelegations.issue/run` use the existing project-authenticated authority transport, bounded
timeouts and disposal. They never cache capabilities/positive user authorization or retry unknown
issuance/consume/operation outcomes. Consume and the target database are not one distributed transaction;
the endpoint must apply its explicit idempotency/unknown-result contract. A consumed decision never
establishes a longer-lived session. Further private WS messages or separate sensitive reads require their
own current guard; an initial connection does not authorize them indefinitely.

Semantic-header digests always include accept, accept-language, content-type/encoding/language,
if-match, if-none-match, range and idempotency-key. The destination's server-owned route declaration must
also list any additional header that changes request semantics/authorization, such as an organization
selector. Names/values are canonically sorted with platform Headers; credentials/hop authentication
headers cannot be additional semantic headers. Outgoing requests must explicitly prepare defaults
(including Accept/Accept-Language) and serialize bodies before hashing. Multipart boundaries must come
from the prepared platform Request, not an independently reserialized FormData. Headers are hashed,
not copied into Cr metadata. A digest supplied by an untrusted browser is not an authorization input.

Implementation/cutover dependencies: migrate Corpus/GLAB provider and target routing, publish route-owned
action/header declarations, retain the target's local ACL, and register source/target service_operations
and consent declarations. Missing destination consent is an explicit denial requiring the normal Cr
consent flow; no mode-off, stale cache, passthrough or anonymous fallback. Every downstream consumer must
understand the explicit delegation scheme before deployment. Source and target credentials remain backend
memory only. No service configuration, tests, restart or deployment is authorized by this specification.
