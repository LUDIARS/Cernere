---
title: GLab profile registration cutover
date: 2026-10-22
---

# GLab profile consolidation

Requested by neco: integrate EducationPartner User Profile into GLab; use GLab for the notification Bot rather than a separate Cr integration.

## Contract

- Cr remains the owner of personal profile data. Add the five existing profile columns to the existing GLab registration, retaining its identity, presence data and credentials.
- Preserve existing GLab values. Conflicting non-null profile values abort the entire migration.
- Preserve Aedilis read access to the profile module only; do not grant access to presence data.
- Change GLab signup fields to its own profile columns. Preserve consent decisions; do not fabricate consent.
- Keep the source registration/data during the coordinated consumer cutover. Retire it only after GLab and Aedilis use the destination and verification succeeds.
- Bot consult notifications use the existing shared SQLite queue. Never reuse Hub launch credentials in another process.

## Deployment order and acceptance

1. Review Cr migration, GLab consumer/Bot change and Aedilis consumer change.
2. Pause profile writers through Excubitor before copying. Keep writers paused until all consumers have switched, preventing stale source writes after the copy.
3. Apply Cr migration through normal startup, deploy GLab and Aedilis, then resume the services.
4. Verify all profile values and GLab presence data are preserved without printing personal values; verify profile reads/writes and limited Aedilis access.
5. Verify Bot has no runtime Cr credential dependency before retiring its registration. Preserve Discord notification delivery state.

No source table/column is dropped. Migration failure rolls back schema and data together.
