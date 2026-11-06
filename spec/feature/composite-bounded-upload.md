# Bounded delegated upload reservations

## SPEC-COMPOSITE-UPLOAD-RESERVATION

Follow-up to merged Cr #3627 (`b2bc69cf2130c719fa4db3db9cdcf44f4c5f5836`).
The ordinary 30-second one-operation delegation contract remains unchanged.
Voluptas currently accepts videos up to 200 MiB and images up to 15 MiB. Reading
the complete body before consuming a 30-second capability cannot preserve slow
200 MiB uploads. Increasing a shared memory ceiling or extending that capability
is not the solution. This separate opt-in contract reserves one bounded transfer,
then authorizes its actual completed body against current authority and data ACLs.

### Limits and immutable operation

The target's administrator-owned `service_operations` entry may declare
`upload: { maximumBytes, timeoutSeconds }` only for `important` actions.
Maximums are 200 MiB and 300 seconds; zero/negative/non-integer/unclassified values
are denied. The target's own route declaration independently bounds size/deadline;
the effective limits are the stricter pair and never exceed the source grant's
remaining lifetime. No browser/header selects the policy or raises these limits.

The source privately captures the exact outgoing bytes before requesting authority.
It uses standard Blob/Node file handling and incremental SHA-256, not a caller-
supplied digest. Its immutable operation includes both projects and credential
generations, registered audiences, source grant/user/device/session binding,
action/risk, canonical method/path/query/resource, semantic-header digest, body
digest, exact byte count and request ID. Replacing bytes after this first digest
fails the target's independent final digest. Multipart boundaries are prepared once.

### Backend protocol

All routes are under `/api/auth/service/`, use current project credentials and the
existing scoped-session/consent checks. These are distinct from ordinary delegation
and cannot be redeemed at its consume endpoint.
The source sends `Authorization: Cernere-Upload <arrivalToken>` with the fixed UUID
`X-Cernere-Request-Id`. Targets select the explicit upload guard, never a Bearer or
ordinary-delegation fallback. These opaque capabilities introduce no new signature.

1. `delegate-upload`: the source submits its bound session, destination and exact
   operation/byte count. Cr validates current source and target permissions,
   explicit consents, equal important classification and target upload policy.
   It returns a 30-second, one-use opaque arrival capability. Unknown outcomes
   are never automatically retried or minted again for the same grant/request ID.
2. `begin-upload`: before reading the HTTP body, the target submits that capability,
   current target credential, server-created random request binding and its actual
   classified method/path/semantic headers/request ID. Cr matches the saved target
   and envelope, rechecks live authority, and atomically consumes the arrival
   capability once. It creates one opaque reservation with a fixed deadline,
   expected digest/bytes and the immutable operation. Both capability and receipt
   remain backend-only. Failure after consumption burns the attempt.
3. The target captures the request privately with bounded memory, disk bytes,
   concurrent leases and route-owned deadline. It stops on disconnect/abort/limit
   violation, never exposes the spool and never writes committed domain data yet.
   Content-Length is only a checked hint; actual bytes determine size/digest.
4. `finalize-upload`: the target supplies reservation/request binding plus the actual
   independently computed body digest/bytes and envelope. Atomic one-use consumption
   happens before a decision; parallel, replayed, wrong-binding and expired attempts
   cannot both succeed. Cr rechecks the original live source grant/user/device/
   session, both projects/generations/audiences, current permissions, both consents
   and consent revision, target policy/risk/limits and the complete operation.
   Unknown/stale/offline authority rejects; there is no positive authorization cache.
5. Only after final Cr permission does the target SDK invoke its latest resource-
   authorization callback immediately before execution. The endpoint retains its
   own row/ownership/organizer/transaction checks. Admin/active/Cr identity is not
   a substitute for those data ACLs. The exact captured body is the execution body.
6. `cancel-upload` burns a target-owned reservation. Disconnect, oversize, deadline,
   digest/envelope mismatch, revocation or any validation/finalization failure must
   prevent execution and release the local spool/lease in `finally`. Authority
   cancellation failure does not retain local private files; Cr expiry bounds the
   remaining reservation. No failure silently restarts the operation.

Reservation finalization and target database commit are not a distributed
transaction. A consumed reservation is never replayed after a failed or unknown
operation result; endpoints use their existing explicit idempotency/result contract.
Reservations cannot become browser sessions, transferable grants or delegation
sources. No new signature/token cryptography, background service or startup
communication is introduced. Small-body callers do not acquire this machinery.

### SDK and host boundary

`CernereComposite.uploads.issue` hashes a captured Blob incrementally before the
arrival capability is minted. It snapshots method/path/header metadata, session
credentials and the Blob reference before awaiting; later wrapper replacement does
not silently change the authorized operation. The source retains the capture until
the actual outgoing HTTP upload ends and releases it in its own `finally`.

`uploads.run` requires important classification, route-owned limits, a live owner,
an abort-aware private capture callback, latest resource ACL callback and execution
callback. It reserves before calling capture, independently hashes the completed
Blob, finalizes once, and passes that exact Blob reference to execution. Its
`finally` aborts the transfer lifetime and disposes local bytes before any best-effort
remote cancellation. A capture callback that fails partway must clean up its own
partial allocation. Unknown execution outcomes never trigger a second finalization.

For the browser-to-own-service leg, `sessions.runCaptured` computes the Blob digest
after bounded intake and uses the existing immediate authorize/consume pair. The
host owns capture disposal. Ordinary `sessions.run` and small-body delegation keep
their existing contract; they gain no implicit large-body or digest-supplied bypass.
No new dependency/version, install hook, telemetry or remote destination is added;
only the already configured project-authenticated Cr authority is contacted.

### Threats and required evidence

- Swapped project/audience/generation/user/session/action/risk/path/query/header/
  resource/request ID/byte count/digest: denied at begin/finalize as applicable.
- Concurrent begin/finalize, replay after cancellation or logout, failure between
  capability consumption and reservation creation: at most one execution, no retry.
- A transfer crossing 30 seconds: only the previously reserved bounded request may
  finish; the old capability is dead, and final authority/data ACLs are checked anew.
- Policy/consent/resource ownership changed mid-transfer, original grant expired or
  revoked, authority unavailable: no commit even if all bytes arrived.
- Source body changed after its digest, truncated/extra body, forged Content-Length,
  slow/disconnected reader, full spool budget: reject and free private resources.
- Existing 15 MiB image/200 MiB video limits and normal small-body semantics: preserve.

Contract tests must exercise these with controlled clocks/streams and atomic Redis
boundaries. Runtime tests remain delegated through Revisor, not executed by the
implementation session. This specification alone does not claim implementation,
consumer adoption, test success or deployment. Cr's coordinated cutover barrier
still requires all necessary consumers/targets and administrator policy settings.

Implementation checkpoint: the four HTTP actions, bounded reservation store,
shared live delegation checks, SDK `uploads` and `sessions.runCaptured` are connected.
Server source and the five relevant HTTP/SDK/store/policy contract sources pass
strict no-emit checks. Runtime verification is submitted to Revisor. Co/GLAB private
spool and explicit upload-scheme adoption at real consumers/targets remain separate
unfinished dependencies; this Cr API/SDK unit alone must not be deployed.
