import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      react: fileURLToPath(new URL("./node_modules/react", import.meta.url)),
      "@ludiars/cernere-composite/ui": fileURLToPath(new URL("../packages/composite/src/ui/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    // 認証ユニットテスト用の決定的な値。本番では絶対に使わない。
    // PASETO 鍵はテストごとに動的生成して別途 env へ注入する (paseto.test.ts)。
    env: {
      NODE_ENV: "test",
      JWT_SECRET: "test-only-cernere-jwt-secret-do-not-use-in-prod",
      CERNERE_ENV: "test",
    },
  },
});
