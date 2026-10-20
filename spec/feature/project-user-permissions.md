# SPEC-PROJECT-USER-PERMISSIONS-001: Effective project user permissions

Authenticated project WebSocket callers can request managed_project.get_user_permissions with userId.
The project is fixed by the authenticated connection; a differing targetProjectKey is rejected.
The response contains only that project's permission keys, purposes and effective allowed flags.
User profile values, other projects' permissions and admin-owned capabilities are not exposed.

Existing consent evaluation is combined with current opt-out records; later refusal overrides a stored grant.
Unconfirmed declarations and revoked service access never become an implicit grant.
This operation is read-only. Changing consent continues to require the user's Cernere permission screen.
The downstream application must derive userId from its authenticated request, never from browser input.
