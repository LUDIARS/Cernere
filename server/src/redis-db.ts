/**
 * Redis の論理 DB 番号 (REDIS_DB)。未設定なら REDIS_URL のまま (従来どおり)。
 * 本社のテスト用 Cernere は本番と同じ REDIS_URL (認証込み) を使い、DB 番号だけ分ける
 * (spec/setup/hq-test-instance.md)。
 */
export function readRedisDb(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.REDIS_DB?.trim();
  if (!raw) return undefined;
  if (!/^\d{1,2}$/.test(raw) || Number(raw) > 15) {
    throw new Error("REDIS_DB must be an integer between 0 and 15");
  }
  return Number(raw);
}
