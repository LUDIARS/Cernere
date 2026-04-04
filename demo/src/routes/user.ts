/**
 * User Routes — ユーザー基本情報の表示
 *
 * GET /api/users          — ユーザー一覧
 * GET /api/users/:id      — ユーザー詳細
 * GET /api/users/:id/full — ユーザー詳細 + 全ExtData
 */

import { Router } from "express";
import { getUser, getAllUsers, getExtDataByUser } from "../store/memory-store.js";
import { toUserResponse } from "../models/user.js";
import { toExtDataSummary, toExtDataResponse } from "../models/ext-data.js";

export const userRouter = Router();

// GET /api/users — ユーザー一覧
userRouter.get("/", (_req, res) => {
  const users = getAllUsers().map(toUserResponse);
  res.json({ users });
});

// GET /api/users/:id — ユーザー詳細
userRouter.get("/:id", (req, res) => {
  const user = getUser(req.params.id);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const extDataList = getExtDataByUser(user.id).map(toExtDataSummary);
  res.json({
    user: toUserResponse(user),
    extData: extDataList,
  });
});

// GET /api/users/:id/full — ユーザー詳細 + 全ExtData展開
userRouter.get("/:id/full", (req, res) => {
  const user = getUser(req.params.id);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const extDataList = getExtDataByUser(user.id).map(toExtDataResponse);
  res.json({
    user: toUserResponse(user),
    extData: extDataList,
  });
});
