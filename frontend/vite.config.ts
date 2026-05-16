import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendUrl = process.env.VITE_BACKEND_URL ?? "http://localhost:8080";
const extraHosts = process.env.VITE_ALLOWED_HOSTS?.split(",").filter(Boolean) || [];

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
    },
  },
});
