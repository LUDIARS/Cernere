/**
 * ログイン通知の宛先管理 (WS module "login_alert")。
 *
 *   list    宛先と連携状況
 *   start   宛先の追加 (試験通知を送る)。action proof login_alert.manage 必須 (WS 層で検証)
 *   verify  試験通知の確認番号で有効化
 *   remove  宛先の削除。action proof login_alert.manage 必須 (WS 層で検証)
 */

import { z } from "zod";

import { db } from "../db/connection.js";
import { AppError } from "../error.js";
import { listAlertTargets, removeAlertTarget, startAlertTarget, verifyAlertTarget } from "./alert-targets.js";

const channelSchema = z.object({ channel: z.enum(["discord", "google"]) }).strict();
const verifySchema = z.object({ channel: z.enum(["discord", "google"]), code: z.string().max(16) }).strict();

export async function loginAlertCommand(userId: string, action: string, payload: unknown): Promise<unknown> {
  switch (action) {
    case "list": return listAlertTargets(userId);
    case "start": {
      const parsed = channelSchema.safeParse(payload);
      if (!parsed.success) throw AppError.badRequest("channel must be discord or google");
      return startAlertTarget(userId, parsed.data.channel);
    }
    case "verify": {
      const parsed = verifySchema.safeParse(payload);
      if (!parsed.success) throw AppError.badRequest("channel and code are required");
      return verifyAlertTarget(userId, parsed.data.channel, parsed.data.code);
    }
    case "remove": {
      const parsed = channelSchema.safeParse(payload);
      if (!parsed.success) throw AppError.badRequest("channel must be discord or google");
      return { removed: await db.transaction((tx) => removeAlertTarget(tx, userId, parsed.data.channel)) };
    }
    default: throw AppError.badRequest("Unknown login_alert action");
  }
}
