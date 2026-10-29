/** @implements SPEC-HQ-TEST-ACCOUNT-DELETION */
export function hqTestAccountDeletionEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.CERNERE_HQ_TEST_ACCOUNT_DELETION !== "true") return false;
  if (env.LISTEN_HOST !== "127.0.0.1") return false;
  if ([env.CERNERE_ENV, env.APP_ENV, env.NODE_ENV].some(value => value === "production" || value === "prod")) return false;
  try {
    const database = new URL(env.DATABASE_URL ?? "");
    return ["postgres:", "postgresql:"].includes(database.protocol)
      && database.pathname === "/cernere_test";
  } catch {
    return false;
  }
}
