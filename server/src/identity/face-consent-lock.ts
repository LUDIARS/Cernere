/** user 単位の同意 mutation を transaction 内で直列化する。 */

import { sql } from "drizzle-orm";
import type { FaceDbClient } from "./face-db-client.js";

export async function lockFaceConsentMutation(
  userId: string,
  client: FaceDbClient,
): Promise<void> {
  await client.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${`face-consent:${userId}`}, 0))
  `);
}

/** 複数 user を触る施設失効では、順序を固定して deadlock を避ける。 */
export async function lockFaceConsentMutations(
  userIds: string[],
  client: FaceDbClient,
): Promise<void> {
  const uniqueUserIds = [...new Set(userIds)].filter(Boolean).sort();
  for (const userId of uniqueUserIds) {
    await lockFaceConsentMutation(userId, client);
  }
}
