/**
 * 利用許可の WS module "user_access" (許可制 案 A)。
 *
 *   status    本人の状態と申請
 *   apply     利用申請 { purpose }
 *   withdraw  申請の取り下げ
 *   list      admin: 審査待ち (status="requests") または状態ごとの一覧
 *   decide    admin: 許可・拒否・ロック・解除 { userId, decision, expectedRevision, reasonCode }。
 *             action proof user_access.decide (resource = userId) を WS 層で確認する
 */

import { z } from "zod";

import { AppError } from "../error.js";
import { sessionRegistry } from "../ws/session-registry.js";
import {
  applyForAccess,
  decideAccess,
  decisionSchema,
  getMyAccess,
  listAccessReview,
  withdrawAccessRequest,
} from "./user-access.js";

const listSchema = z.object({ status: z.enum(["requests", "pending", "active", "locked"]) }).strict();
const applySchema = z.object({ purpose: z.string() }).strict();

export async function userAccessCommand(userId: string, action: string, payload: unknown): Promise<unknown> {
  switch (action) {
    case "status": {
      // 連携しているアカウントは主の許可状態で表示する (account-federation §3)。
      const view = await getMyAccess(userId);
      const { effectiveAccessStatus } = await import("../federation/subject.js");
      return { ...view, status: await effectiveAccessStatus(userId) };
    }
    case "apply": {
      const parsed = applySchema.safeParse(payload);
      if (!parsed.success) throw AppError.badRequest("purpose is required");
      return applyForAccess(userId, parsed.data.purpose);
    }
    case "withdraw": return withdrawAccessRequest(userId);
    case "list": {
      const parsed = listSchema.safeParse(payload ?? { status: "requests" });
      if (!parsed.success) throw AppError.badRequest("status must be requests, pending, active or locked");
      return { items: await listAccessReview(userId, parsed.data.status) };
    }
    case "decide": {
      const parsed = decisionSchema.safeParse(payload);
      if (!parsed.success) throw AppError.badRequest("userId, decision, expectedRevision and reasonCode are required");
      const result = await decideAccess(userId, parsed.data);
      // 状態が変わると epoch が進み、古いセッションは再認証になる。開いているソケットも閉じる。
      sessionRegistry.closeUser(parsed.data.userId, "Account access changed");
      return result;
    }
    default: throw AppError.badRequest("Unknown user_access action");
  }
}
