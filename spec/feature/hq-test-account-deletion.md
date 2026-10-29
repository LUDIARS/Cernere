# 本社テスト用アカウント削除

ID: SPEC-HQ-TEST-ACCOUNT-DELETION

neco requested account-level deletion in the HQ test environment to repeat GLab signup.
Profile displays a self-account deletion section only when the authenticated backend
reports the capability enabled. The server requires all of:

- CERNERE_HQ_TEST_ACCOUNT_DELETION=true (default disabled).
- LISTEN_HOST=127.0.0.1 and DATABASE_URL database name cernere_test.
- No production/prod value in CERNERE_ENV, APP_ENV or NODE_ENV.

Enable the flag only in the HQ CernereTest Vault binding for cernere-test; never in
the shared cernere binding. Existing production account-deletion API semantics remain unchanged.
The UI uses authenticated WebSocket user.delete_account and its existing passkey
action proof. hqTest requests must pass the server capability check, omit userId and
confirm DELETE. Another account cannot be selected in this UI.

Deletion uses existing deleteUserAccount: Cernere credentials, profile, consent and
project user-data cascade with account deletion. Organization owners are rejected.
Independently stored service content is not claimed to be deleted. The final screen
explains scope, irreversibility and logout; the agent does not delete an actual account
as part of deployment. Re-registration is a user action after deletion.

Validation: pure gate coverage for disabled, production, non-loopback, wrong database,
and malformed URL; browser verification must confirm absence on production and
confirmation/passkey flow on the isolated HQ instance. Actual destructive UI testing
requires an explicitly disposable account and action-time confirmation.
