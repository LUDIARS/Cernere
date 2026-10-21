# SPEC-PROJECT-REGISTRATIONS-001: Project registration feed

`managed_project.list_registrations` is available only on authenticated project WS.
The authenticated project fixes the storage table. Payload permits only an optional
UUID `after` cursor; caller-selected project keys are rejected. The response exposes
at most 100 registered service subject IDs and registration dates, plus `next`.
Names, profile values, credentials and other projects' registrations are excluded.

The existing Cr signup/consent and project-entry hooks persist these rows. Reading
committed rows instead of sending a transient webhook lets consumers recover from
outages without losing registrations. Consumers complete a pass then restart from
the beginning, deduplicate by service subject, and never treat registration as admin
approval. This endpoint does not create accounts, grant access or change consent.

GLab uses this feed to create pending eligibility requests and notify its administrator.
