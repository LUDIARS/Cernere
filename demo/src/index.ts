/**
 * Demo: User ExtData Server
 *
 * ユーザー基本情報の表示と ExtData (拡張データ) の表示・書き換えを行う
 * デモ用 Express サーバー。
 *
 * 起動: npm start / npm run dev
 *
 * エンドポイント:
 *   GET    /api/users                          — ユーザー一覧
 *   GET    /api/users/:id                      — ユーザー詳細 + ExtData概要
 *   GET    /api/users/:id/full                 — ユーザー詳細 + 全ExtData展開
 *   GET    /api/users/:userId/ext/:namespace   — ExtData取得
 *   PUT    /api/users/:userId/ext/:namespace   — ExtData全体書き換え
 *   PATCH  /api/users/:userId/ext/:namespace   — ExtData部分更新
 *   DELETE /api/users/:userId/ext/:namespace   — ExtData削除
 */

import express from "express";
import { userRouter } from "./routes/user.js";
import { extDataRouter } from "./routes/ext-data.js";
import { seedData } from "./store/memory-store.js";

const app = express();
const PORT = Number(process.env.PORT) || 3100;

app.use(express.json());

// ── Routes ────────────────────────────────────────────

app.use("/api/users", userRouter);
app.use("/api/users/:userId/ext", extDataRouter);

// ── Health Check ──────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Startup ───────────────────────────────────────────

seedData();
console.log("[demo] Seed data loaded");

app.listen(PORT, () => {
  console.log(`[demo] User ExtData server running on http://localhost:${PORT}`);
  console.log("");
  console.log("  Endpoints:");
  console.log(`    GET    /api/users`);
  console.log(`    GET    /api/users/:id`);
  console.log(`    GET    /api/users/:id/full`);
  console.log(`    GET    /api/users/:userId/ext/:namespace`);
  console.log(`    PUT    /api/users/:userId/ext/:namespace`);
  console.log(`    PATCH  /api/users/:userId/ext/:namespace`);
  console.log(`    DELETE /api/users/:userId/ext/:namespace`);
  console.log("");
  console.log("  Seed users: u-001 (tanaka), u-002 (suzuki), u-003 (yamada)");
  console.log("  Seed namespaces: profile, settings");
});
