# Managed-Project JSON Double Encoding

- Date: 2026-08-06
- Status: fixed in working tree
- Area: Cernere managed-project storage
- Severity: blocks JSON-backed project features

## Summary

The Memoria #657 HASTER live E2E successfully wrote a Volputas voice record, but
the following persona analysis rejected `voice_records` because Cernere returned
a string instead of an array. This is a managed-project JSON round-trip
regression affecting every JSON/JSONB user-data column.

## Evidence

At 2026-08-06 15:14 JST,
`POST /api/v1/profile-data/voices` returned 201, then
`POST /api/v1/profile-data/persona/analyze` returned
`INVALID_PROFILE_INPUT: Cernere returned invalid voice_records data`. A direct,
shape-only database check reported
`jsonb_typeof(project_data_volputas.voice_records) = 'string'`.

The write path is `setUserData()` in `server/src/project/service.ts`.

## Regression Context

Unit tests mocked the managed-project command boundary and did not exercise the
postgres.js JSON parameter encoder. The Volputas profile schema was present and
correct; the failure occurred after a successful write response.

## Cause

`setUserData()` called `JSON.stringify()` and then passed the resulting string to
postgres.js for a JSONB target column. postgres.js encoded that JavaScript string
as a JSON string, so an input array became a JSONB string containing serialized
array text.

## Fix Requirements

- Bind JSON/JSONB values using postgres.js's explicit `sql.json()` parameter.
- Preserve arrays and objects without stringifying them first.
- Leave non-JSON column bindings unchanged.
- Repair the synthetic HASTER row written before the fix and rerun T14/T16.

## Verification

`server/tests/project/user-data-parameter.test.ts` pins explicit JSON parameter
binding and the original value shape. The live E2E must additionally confirm
that `voice_records` is a JSONB array and persona analysis succeeds.

## Follow-up

After merge, restart Cernere through Excubitor, convert only the affected HASTER
fixture value back to an array, and complete the Discord TestWorkflow record.
