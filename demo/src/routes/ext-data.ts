/**
 * ExtData Routes — ユーザー拡張データの表示・書き換え
 *
 * GET    /api/users/:userId/ext/:namespace — ExtData取得
 * PUT    /api/users/:userId/ext/:namespace — ExtData全体書き換え
 * PATCH  /api/users/:userId/ext/:namespace — ExtData部分更新 (null で削除)
 * DELETE /api/users/:userId/ext/:namespace — ExtData削除
 */

import { Router, type Request } from "express";
import { getUser, getExtData, upsertExtData, patchExtData, deleteExtData } from "../store/memory-store.js";
import { toExtDataResponse } from "../models/ext-data.js";

type ExtDataParams = { userId: string; namespace: string };

export const extDataRouter = Router({ mergeParams: true });

// GET /api/users/:userId/ext/:namespace
extDataRouter.get("/:namespace", (req: Request<ExtDataParams>, res) => {
  const { userId, namespace } = req.params;
  const user = getUser(userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const ext = getExtData(userId, namespace);
  if (!ext) {
    res.status(404).json({ error: `ExtData "${namespace}" not found for user ${userId}` });
    return;
  }

  res.json(toExtDataResponse(ext));
});

// PUT /api/users/:userId/ext/:namespace — 全体書き換え
extDataRouter.put("/:namespace", (req: Request<ExtDataParams>, res) => {
  const { userId, namespace } = req.params;
  const user = getUser(userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const data = req.body;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    res.status(400).json({ error: "Request body must be a JSON object" });
    return;
  }

  const ext = upsertExtData(userId, namespace, data);
  res.json(toExtDataResponse(ext));
});

// PATCH /api/users/:userId/ext/:namespace — 部分更新
extDataRouter.patch("/:namespace", (req: Request<ExtDataParams>, res) => {
  const { userId, namespace } = req.params;
  const user = getUser(userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const patch = req.body;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    res.status(400).json({ error: "Request body must be a JSON object" });
    return;
  }

  const ext = patchExtData(userId, namespace, patch);
  if (!ext) {
    res.status(404).json({ error: `ExtData "${namespace}" not found for user ${userId}` });
    return;
  }

  res.json(toExtDataResponse(ext));
});

// DELETE /api/users/:userId/ext/:namespace
extDataRouter.delete("/:namespace", (req: Request<ExtDataParams>, res) => {
  const { userId, namespace } = req.params;
  const user = getUser(userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const deleted = deleteExtData(userId, namespace);
  if (!deleted) {
    res.status(404).json({ error: `ExtData "${namespace}" not found for user ${userId}` });
    return;
  }

  res.json({ message: `ExtData "${namespace}" deleted for user ${userId}` });
});
