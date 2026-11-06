# SPEC-COMPOSITE-SCOPED-IDENTITY: Narrow identity operations from a bound service

This extends the project/PKCE session contract without restoring global user
access/refresh credentials. Explicit authority actions expose only the bound grant's
own native-account organization memberships and current face-consent status,
creation and withdrawal. Inputs cannot select an arbitrary user, module, URL,
reviewer, revocation reason or biometric payload.

Each requires the source project's current registered service operation, all its
permissions and explicit consent, including reads. Organization membership and
consent reads are fixed sensitive_read; consent mutations are fixed important.
An administrator cannot lower these classifications to read. The existing operation
authorize/consume contract binds project/grant/user/session/action/risk/resource,
the exact JSON payload digest and request ID. The Cr data handler itself consumes
the one-use permit before executing. A consumed permit cannot be reused as a bearer
or returned to the caller for later execution. Unknown outcomes are not retried.
The SDK also requires the service's synchronous current-owner check before permission
work, again before the actual data request, and before delivering its result. Logout
during permission preparation cannot launch a subsequent identity mutation. Once a
remote operation has begun, its outcome is explicitly not a distributed transaction
with local logout; it is never automatically retried.

The target native user is taken only from the already verified grant source. Current
membership queries are constrained to that user; face-consent mutations retain the
existing membership/version/lock/transaction rules and audit behavior. Organization
responses contain only own organization id/name/role, with a bounded 1000-entry result.
Photos/templates remain absent from Cr; the 2026-09-12 removal is unchanged.

Adopting projects must explicitly configure the matching service_operations and
grants/consent before cutover. These APIs are implementation candidates; Corpus/GLAB
wiring, contract validation and all coordinated consumer migration remain required.
No tests, deployment or Revisor acceptance is claimed by this specification.
