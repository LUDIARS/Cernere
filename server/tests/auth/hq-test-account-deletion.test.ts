import assert from "node:assert/strict";
import { test } from "vitest";
import { hqTestAccountDeletionEnabled } from "../../src/auth/hq-test-account-deletion.js";

test("HQ account deletion requires every isolation boundary", () => {
  const enabled = { CERNERE_HQ_TEST_ACCOUNT_DELETION: "true", LISTEN_HOST: "127.0.0.1", DATABASE_URL: "postgres://localhost/cernere_test" };
  assert.equal(hqTestAccountDeletionEnabled(enabled), true);
  for (const patch of [
    { CERNERE_HQ_TEST_ACCOUNT_DELETION: undefined },
    { LISTEN_HOST: "0.0.0.0" },
    { DATABASE_URL: "postgres://localhost/cernere" },
    { DATABASE_URL: "invalid" },
    { DATABASE_URL: "https://localhost/cernere_test" },
    { NODE_ENV: "production" },
    { CERNERE_ENV: "prod" },
    { APP_ENV: "production" },
  ]) assert.equal(hqTestAccountDeletionEnabled({ ...enabled, ...patch }), false);
});
