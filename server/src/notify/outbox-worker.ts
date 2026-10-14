/**
 * notification_outbox の配送 worker (SPEC-LOGIN-ALERT)。
 *
 * 期限の来た行を lease (FOR UPDATE SKIP LOCKED) して配送する。複数プロセスでも同じ行を
 * 二重に掴まない。失敗は指数バックオフ + jitter で再試行し、上限か恒久失敗で failed にする。
 * 送信直後のクラッシュで重複が起きうる (少なくとも一度の配送)。配送の失敗でログイン等を止めない。
 */

import { eq, sql } from "drizzle-orm";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { devError } from "../logging/dev-logger.js";
import { markAlertTargetDegraded } from "./alert-targets.js";
import { deliverAlert, type DeliverableEvent } from "./alert-delivery.js";
import { AlertDeliveryError } from "./discord-alert-sender.js";
import type { SecurityEventDetail, SecurityEventKind, SecuritySeverity } from "./security-events.js";

const BATCH = 20;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 10;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 60 * 60 * 1000;
const POLL_MS = 5_000;

export function backoffMs(attempts: number, random = Math.random): number {
  const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(delay * (0.5 + random() / 2));
}

interface LeasedRow {
  id: string;
  channel: string;
  target_ref: string;
  attempts: number;
  event_id: string;
  user_id: string;
  kind: string;
  severity: string;
  detail: SecurityEventDetail;
  created_at: Date | string;
}

async function leaseDue(): Promise<LeasedRow[]> {
  const result = await db.execute(sql`
    UPDATE notification_outbox o
       SET leased_until = now() + ${`${LEASE_MS} milliseconds`}::interval,
           attempts = o.attempts + 1
      FROM security_events e
     WHERE o.event_id = e.id
       AND o.id IN (
         SELECT id FROM notification_outbox
          WHERE delivered_at IS NULL AND failed_at IS NULL
            AND next_attempt_at <= now()
            AND (leased_until IS NULL OR leased_until < now())
          ORDER BY next_attempt_at
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED)
    RETURNING o.id, o.channel, o.target_ref, o.attempts, e.id AS event_id, e.user_id, e.kind, e.severity, e.detail, e.created_at`);
  return result as unknown as LeasedRow[];
}

function toEvent(row: LeasedRow): DeliverableEvent {
  return {
    id: row.event_id,
    userId: row.user_id,
    kind: row.kind as SecurityEventKind,
    severity: row.severity as SecuritySeverity,
    detail: row.detail ?? {},
    createdAt: new Date(row.created_at),
  };
}

async function deliverOne(row: LeasedRow): Promise<void> {
  try {
    await deliverAlert(row.channel, row.target_ref, toEvent(row));
    await db.update(schema.notificationOutbox).set({ deliveredAt: new Date(), leasedUntil: null, lastError: null })
      .where(eq(schema.notificationOutbox.id, row.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof AlertDeliveryError && err.permanent;
    const exhausted = row.attempts >= MAX_ATTEMPTS;
    if (permanent && (row.channel === "discord" || row.channel === "google")) {
      await markAlertTargetDegraded(row.channel, row.target_ref);
    }
    const retryAfter = err instanceof AlertDeliveryError && err.retryAfterMs ? err.retryAfterMs : backoffMs(row.attempts);
    await db.update(schema.notificationOutbox).set({
      leasedUntil: null,
      lastError: message.slice(0, 500),
      ...(permanent || exhausted
        ? { failedAt: new Date() }
        : { nextAttemptAt: new Date(Date.now() + retryAfter) }),
    }).where(eq(schema.notificationOutbox.id, row.id));
  }
}

/** 1 回分を処理し、処理した行数を返す。 */
export async function drainOutboxOnce(): Promise<number> {
  const rows = await leaseDue();
  for (const row of rows) await deliverOne(row);
  return rows.length;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** サーバー起動時に呼ぶ。一定間隔で配送待ちを処理する。 */
export function startOutboxWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    drainOutboxOnce()
      .catch((err) => devError("notify.outbox.drainFailed", err, {}))
      .finally(() => { running = false; });
  }, POLL_MS);
  timer.unref();
}

export function stopOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
