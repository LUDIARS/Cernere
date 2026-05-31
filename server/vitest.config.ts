import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // 認証ユニットテスト用の決定的な値。本番では絶対に使わない。
    // PASETO 鍵はテストごとに動的生成して別途 env へ注入する (paseto.test.ts)。
    env: {
      JWT_SECRET: "test-only-cernere-jwt-secret-do-not-use-in-prod",
      CERNERE_ENV: "test",
    },
  },
});
