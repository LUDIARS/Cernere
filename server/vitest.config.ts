import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      react: fileURLToPath(new URL("./node_modules/react", import.meta.url)),
      "react-router-dom": fileURLToPath(new URL("../frontend/node_modules/react-router-dom/dist/index.mjs", import.meta.url)),
      // The registered server-only review setup prepares this real test runtime
      // dependency, pinned to the frontend/SDK's existing 13.3.0 artifact. Source
      // aliases must not assume SDK-local or frontend node_modules junctions.
      // Frontend production still dedupes to its own declared runtime copy.
      "@simplewebauthn/browser": fileURLToPath(new URL("./node_modules/@simplewebauthn/browser/esm/index.js", import.meta.url)),
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
