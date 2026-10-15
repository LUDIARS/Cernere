/**
 * 同意の判断を user_data_optouts へ反映する (設計書 §5.3)。
 *
 * - user_data.module:<m> の拒否は既存の module opt-out と同じ処理 (記録 + 該当列の NULL 化) を通す。
 * - profile / identity_claim / oidc の拒否は `consent:<key>` を記録するだけで、共通プロフィール
 *   そのものは消さない (「渡さない」だけ)。
 * - 許可に戻した権限は拒否の記録を外す (削除済みのデータは戻らない — 既存 opt-out と同じ)。
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { consentOptoutCategory, consentServiceId, deniedPermissionKeys } from "./denials.js";
import { IDENTITY_BASIC, parsePermissionKey } from "./permission-keys.js";
import type { ConsentSubject } from "./store.js";

export async function applyConsentDenials(
  userId: string,
  subject: ConsentSubject,
  decision: { granted: readonly string[]; denied: readonly string[] },
): Promise<void> {
  const serviceId = consentServiceId(subject);
  const current = await deniedPermissionKeys(userId, serviceId);
  const svc = subject.kind === "project" ? await import("../project/service.js") : null;

  for (const key of decision.denied) {
    if (key === IDENTITY_BASIC || current.has(key)) continue;
    const parsed = parsePermissionKey(key);
    if (!parsed) continue;
    if (parsed.kind === "user_data") {
      if (svc) await svc.setModuleOptout(userId, subject.key, parsed.name);
      continue;
    }
    await db.insert(schema.userDataOptouts).values({
      userId, serviceId, categoryKey: consentOptoutCategory(key),
    }).onConflictDoNothing();
  }

  for (const key of decision.granted) {
    if (!current.has(key)) continue;
    const parsed = parsePermissionKey(key);
    if (!parsed) continue;
    if (parsed.kind === "user_data") {
      if (svc) await svc.removeModuleOptout(userId, subject.key, parsed.name);
      continue;
    }
    await db.delete(schema.userDataOptouts).where(and(
      eq(schema.userDataOptouts.userId, userId),
      eq(schema.userDataOptouts.serviceId, serviceId),
      eq(schema.userDataOptouts.categoryKey, consentOptoutCategory(key)),
    ));
  }
}
