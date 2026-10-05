# Aedilis Composite login origin

The `cernere` service's `CERNERE_COMPOSITE_ALLOWED_ORIGINS` catalog setting
includes `https://ae.ai-run-do.com`. Aedilis opens `/composite/login` with that
origin and receives a one-time auth code through `postMessage`.

On 2026-10-05 the public Composite allowed-origins endpoint omitted Aedilis,
so the login page rejected the recipient before showing its shared login card.
Keep `http://localhost:5187`, `https://glm.ai-run-do.com` and
`https://glab.ai-run-do.com`, which were already active recipients. The configured
Cernere frontend origin is also included by `server/src/config.ts`.

This is an exact-origin configuration correction. Origin validation, credentials,
token exchange and the shared Composite UI are unchanged. Related contract:
[Composite embedded login](../interface/auth-flows.md#5-composite-埋め込みログイン).

Reflect the catalog on the Excubitor site serving the public Cernere hostname,
then restart only its `cernere` backend through Excubitor: this setting is read
at process startup. Preserve any site overrides and check for higher-priority
Vault settings before concluding that the catalog controls the effective value.
Acceptance: the public `/api/auth/composite/allowed-origins` response retains
the previous entries and includes `https://ae.ai-run-do.com`; opening Composite
from Aedilis no longer shows a disallowed-recipient error. Completing a user
login additionally requires an authenticated user's interaction.
