# PC enrollment reused the smartphone identity

User observed NotAllowedError after smartphone login followed by Prepare registration.
The old page added a credential to the phone-authenticated account and requested a
second assertion on the PC before creation. This did not match the intended identity
model: independently registered PC identities must be federated, including multiple
registrations from one physical device.

The enrollment route now uses existing approved new-device federation, deliberately
omitting the phone session from joiner creation. After phone-side approval, a fresh
save click creates a platform credential. The existing server transaction creates
the account, credential and membership together, retaining the federation subject.
Existing request completion locking rejects concurrent or repeated completion.
The UI stores the PC session and registration marker only after successful completion.

Frontend build passed. Local tests were not executed; regression tests submitted to
Revisor cover identity separation, explicit save activation, failure and duplicate
submission. Actual Windows Hello display remains unverified until production use.
