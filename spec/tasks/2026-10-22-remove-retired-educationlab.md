---
task: Remove retired EducationLab registration
project: Cr
kind: maintenance
created: 2026-10-22
memory_links: []
---

The user explicitly requested removal of the retained EducationLab source after
GLab consolidation. Migration 077 removes that inactive registration, its legacy
data rows, consent/opt-out copies and cascading definition/credential history.
GLab's registration, credentials, data, consent decisions and shared profiles must
remain untouched. Audit logs and old migration source files are not erased.

The migration is one atomic statement. It refuses active or unexpected identities,
missing destination users/consents/opt-outs, older destination data, and remaining
integrations. An already removed source is a no-op. Empty historical table structure
remains to avoid breaking migration compatibility; it contains no source data.

Acceptance: EducationLab registration and source rows are absent after deployment;
GLab remains active with the same data and permissions. Use the normal reviewed
migration/startup deployment path, never an ad-hoc production database deletion.
Run with GLab writers stopped, and verify GLab after resuming through Excubitor.
