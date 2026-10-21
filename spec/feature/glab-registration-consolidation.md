# GLab registration consolidation

The canonical managed project is `glab`, displayed as `GLab`. Migration 075 copies
EducationLab presence data and consent/opt-out settings into it and disables the old
registration. Source rows and append-only consent/definition history remain intact.
The destination storage slug and credentials are not replaced. Existing launch
credentials for both registrations are revoked; Excubitor issues fresh glab credentials.

Deployment requires stopping GLab writers, applying the Cernere migration, then deploying
GLab configured for project key/storage audience `glab`. Users must log in again.
Destination data/consent conflicts, schema mismatch or unhandled integrations abort the
whole migration; operators must not override these guards or mark it applied manually.

Acceptance: only glab is active; all four pre-migration presence rows survive; refusal
and consent remain effective; GLab launches with glab credentials and renders GLab.

Migration 076 completes signup-field acknowledgement history (`fields_version`,
`fields_seen`) omitted by 075. It fills only a destination whose two fields are NULL,
whose consent decision still matches the source, and whose source registration is
inactive. A subsequent GLab submission is never overwritten. The source is retained.
Acceptance: untouched migrated acknowledgements match the source; new GLab history
and changed consent decisions remain unchanged on initial application and rerun.
