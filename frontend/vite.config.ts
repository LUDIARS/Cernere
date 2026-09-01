import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 認証 UI の本流は埋め込み SDK (packages/composite)。 Cernere フロントは publish 済み
// パッケージではなく同一リポのソースを直接取り込む (file: 依存だと install 前に dist を
// 作る必要があり、 worktree で事故りやすい)。 tsconfig.json の paths と対で保つ。
const compositeUiSrc = fileURLToPath(new URL("../packages/composite/src/ui/index.ts", import.meta.url));

const backendUrl = process.env.VITE_BACKEND_URL ?? "http://localhost:8080";
const extraHosts = [
  ...(process.env.VITE_ALLOWED_HOSTS?.split(",").filter(Boolean) ?? []),
  ...(process.env.LUDIARS_ALLOWED_HOSTS?.split(",").map(s => s.trim()).filter(Boolean) ?? []),
];

// Cloudflare Tunnel 越し (例: cernere-d.vtn-game.com) で開く場合、
// HMR の WebSocket は tunnel hostname + 443/wss で張る必要がある。
// VITE_PUBLIC_HOST が設定されているときは HMR client がその host:443 に
// 接続するよう明示する。 未設定なら Vite の既定 (localhost:5173 ws) のまま。
const publicHost = process.env.VITE_PUBLIC_HOST;
const hmr = publicHost
  ? { host: publicHost, clientPort: 443, protocol: "wss" as const }
  : undefined;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ludiars/cernere-composite/ui": compositeUiSrc,
    },
    // SDK ソースは frontend/ の外にあるため、 react / WebAuthn を packages/composite 側の
    // node_modules から二重に解決させない (React が 2 つあると hooks が壊れる)。
    dedupe: ["react", "react-dom", "@simplewebauthn/browser"],
  },
  server: {
    port: 5173,
    host: "0.0.0.0",
    allowedHosts: [...extraHosts],
    hmr,
    proxy: {
      "/api": {
        target: backendUrl,
        changeOrigin: true,
      },
      "/auth": {
        target: backendUrl,
        changeOrigin: true,
        ws: true,
      },
      "/ws/project": {
        target: backendUrl,
        changeOrigin: true,
        ws: true,
      },
      // PASETO V4 公開鍵配布 endpoint (= 各 LUDIARS サービスが起動時に fetch する)。
      // proxy が無いと Vite の SPA fallback で index.html が返り、 サービス側 JSON parse 失敗
      "/.well-known": {
        target: backendUrl,
        changeOrigin: true,
      },
    },
  },
});
