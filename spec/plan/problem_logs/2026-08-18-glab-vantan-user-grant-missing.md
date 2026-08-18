# GLAB Vantan Profile Grant Missing

- Date: 2026-08-18
- Status: fixed in working tree
- Area: Cernere managed-project data sharing
- Severity: high — GLAB's required profile gate blocked every panel

## Summary

GLAB could authenticate to Cernere but could not read its required Vantan profile. The UI rendered the generic profile-unavailable state, which prevented every GLAB panel from loading.

## Evidence

- The GLAB runtime log on 2026-08-18 recorded four failed profile reads from `vantan-user`: `Project "glab" has no data_sharing grant on project "vantan_user"`.
- `migrations/027_education-lab_vantan_user_profile.sql` grants `vantan_user` profile access to the historical `EducationLab` project key, while GLAB authenticates as the current `glab` project key.
- GLAB requires `name`, `role_title`, and `department_name` through `managed_project.get_user_data` and `set_user_data`, so the grant must be `readwrite` and restricted to those fields.

## Regression Context

The GLAB profile gate was introduced after the original `EducationLab` profile migration. The new GLAB project key was not added to the Cernere-owned `data_sharing` definition, causing the launch-time authorization regression.

## Cause

`vantan_user.schema_definition.data_sharing` had no entry for caller project `glab`. Cernere correctly failed closed rather than exposing or updating user profile data without an explicit grant.

## Fix Requirements

- Grant `glab` readwrite access only to the `profile` module's `name`, `role_title`, and `department_name` columns.
- Retain existing grants, including the historical `EducationLab` entry.
- Keep the correction reproducible through a numbered Cernere migration.

## Verification

- The Cernere administrative grant CLI completed successfully against the active `vantan_user` definition with `glab`, `profile`, the three required columns, and `readwrite` access.
- No service restart, launch test, unit test, or integration test was performed, per session policy.
- Reloading GLAB should now allow the existing profile read to reach either the registration form or the requested panel; this requires no service restart.

## Follow-up

- `migrations/042_glab_vantan_user_data_sharing.sql` makes the live correction reproducible for clean and future environments.
