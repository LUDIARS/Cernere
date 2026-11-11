# SPEC-PROJECT-USER-PERMISSIONS-001: Effective project user permissions

Authenticated project WebSocket callers can request managed_project.get_user_permissions with userId.
The project is fixed by the authenticated connection; a differing targetProjectKey is rejected.
The response contains only that project's permission keys, purposes and effective allowed flags.
User profile values, other projects' permissions and admin-owned capabilities are not exposed.

Existing consent evaluation is combined with current opt-out records; later refusal overrides a stored grant.
Unconfirmed declarations and revoked service access never become an implicit grant.
This operation is read-only. Changing consent continues to require the user's Cernere permission screen.
The downstream application must derive userId from its authenticated request, never from browser input.

Each permission also carries `state`: `granted` (allowed now), `denied` (the user opted out; re-login never asks again,
only the user's Cernere permission screen `/data-optout` restores it) or `undecided` (not an explicit refusal:
pending consent, unconfirmed declaration or revoked service access).
`optedOutModules` lists every `user_data` module the user opted out of for this project, including modules that are
not declared as consent permissions, so the service can explain why its columns read back empty.
Both fields are additive; `allowed` keeps its meaning for existing callers.
