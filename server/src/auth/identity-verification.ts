/**
 * 本人確認 (Identity Verification)
 *
 * 認証 (composite / 通常) 成功後に、以下の情報からデバイスフィンガープリントを
 * 生成し、ユーザーの「信頼済みデバイス」と照合する。
 *
 *   - マシン情報   (Platform, OS, アーキテクチャ, スクリーン, タイムゾーン, 言語)
 *   - ブラウザ情報 (UA, ベンダー, ブラウザ名/バージョン)
 *   - 位置情報     (緯度経度を 1 度単位に丸めたもの, IP の国/地域)
 *
 * 新しい/普段と異なる環境を検知した場合は、6 桁の確認コードを生成し
 * メールで送信、ユーザーに対話的入力を要求する。
 *
 * チャレンジ状態は Redis に 10 分間保持される。
 */

import crypto from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { redis } from "../redis.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { config } from "../config.js";
import { sendMail } from "./mailer.js";

// ── 公開型 ────────────────────────────────────────────────────

/** クライアントから受け取る生のフィンガープリント */
export interface DeviceFingerprint {
  /** OS / プラットフォーム情報 (例: { os: "macOS", platform: "MacIntel", arch: "arm64", screen: "2560x1440", timezone: "Asia/Tokyo", language: "ja-JP" }) */
  machine?: Record<string, unknown>;
  /** ブラウザ情報 (例: { ua: "...", vendor: "Apple", browser: "Safari", version: "17.4" }) */
  browser?: Record<string, unknown>;
  /** 位置情報 (例: { latitude: 35.6, longitude: 139.6, accuracy: 100, source: "geolocation" }) */
  geo?: Record<string, unknown>;
}

/** 検知された差分 (普段と異なる点) */
export type Anomaly =
  | "new_device"
  | "new_os"
  | "new_browser"
  | "new_location"
  | "new_ip"
  | "missing_fingerprint";

export interface DeviceCheckResult {
  /** デバイスが信頼済みなら true。false の場合は確認が必要 */
  trusted: boolean;
  /** 本人確認チャレンジトークン (Redis に保存された challenge を引くキー) */
  deviceToken?: string;
  /** 既に観測されている差分 (UI 表示用) */
  anomalies: Anomaly[];
  /** マスクされたメール (例: u***@example.com) */
  emailMasked?: string;
  /** 確認コードの送信先メソッド */
  codeChannel?: "email" | "console";
  /** デバッグ用ラベル (例: "macOS · Chrome 124 · Tokyo, JP") */
  label: string;
}

const CHALLENGE_TTL = 10 * 60;       // 10 分
const CODE_LENGTH = 6;
const MAX_ATTEMPTS = 5;

// ── 内部: ハッシュ計算 / 正規化 ───────────────────────────────

/** フィンガープリントの正規化 (緯度経度は 1 度に丸める = 約 100km 単位) */
function normalize(fp: DeviceFingerprint): {
  machine: Record<string, unknown>;
  browser: Record<string, unknown>;
  geo: Record<string, unknown>;
} {
  const m = (fp.machine ?? {}) as Record<string, unknown>;
  const b = (fp.browser ?? {}) as Record<string, unknown>;
  const g = (fp.geo ?? {}) as Record<string, unknown>;

  // 大まかな位置 (1 度単位)。geolocation がない場合は IP-based の country/region のみ使う
  const lat = typeof g.latitude === "number" ? Math.round(g.latitude as number) : null;
  const lng = typeof g.longitude === "number" ? Math.round(g.longitude as number) : null;

  const geoNorm: Record<string, unknown> = {};
  if (lat !== null && lng !== null) {
    geoNorm.lat = lat;
    geoNorm.lng = lng;
  }
  if (typeof g.country === "string") geoNorm.country = g.country;
  if (typeof g.region === "string") geoNorm.region = g.region;
  if (typeof g.city === "string") geoNorm.city = g.city;

  return {
    machine: {
      os: m.os ?? null,
      platform: m.platform ?? null,
      arch: m.arch ?? null,
      screen: m.screen ?? null,
      timezone: m.timezone ?? null,
      language: m.language ?? null,
    },
    browser: {
      vendor: b.vendor ?? null,
      browser: b.browser ?? null,
      version: b.version ?? null,
    },
    geo: geoNorm,
  };
}

/** 正規化済みフィンガープリントから安定したハッシュを生成 */
export function computeDeviceHash(fp: DeviceFingerprint): string {
  const norm = normalize(fp);
  const json = JSON.stringify(norm, Object.keys(norm).sort());
  return crypto.createHash("sha256").update(json).digest("hex");
}

/** "macOS · Chrome 124 · Tokyo, JP" のような表示ラベルを生成 */
export function computeDeviceLabel(fp: DeviceFingerprint): string {
  const m = (fp.machine ?? {}) as Record<string, unknown>;
  const b = (fp.browser ?? {}) as Record<string, unknown>;
  const g = (fp.geo ?? {}) as Record<string, unknown>;

  const parts: string[] = [];
  if (m.os) parts.push(String(m.os));
  if (b.browser) {
    parts.push(b.version ? `${b.browser} ${b.version}` : String(b.browser));
  }
  const place = [g.city, g.country].filter((x) => typeof x === "string" && x).join(", ");
  if (place) parts.push(place);
  return parts.join(" · ") || "Unknown device";
}

// ── 公開: デバイスチェック ────────────────────────────────────

/**
 * 信頼済みデバイス一覧と照合し、信頼済みかチャレンジが必要かを判定する。
 *
 * 信頼済み: last_seen_at を更新して { trusted: true } を返す。
 * 未知    : 確認コードを生成し Redis に保存、メール送信して
 *           { trusted: false, deviceToken, anomalies, emailMasked } を返す。
 */
export async function checkDevice(
  user: { id: string; email: string | null },
  fp: DeviceFingerprint | undefined,
  ctx: { ip?: string; userAgent?: string } = {},
): Promise<DeviceCheckResult> {
  // フィンガープリントが届かない場合は安全側に倒し、本人確認を要求する
  if (!fp || (!fp.machine && !fp.browser && !fp.geo)) {
    const challenge = await issueChallenge(user, fp ?? {}, ctx, ["missing_fingerprint"]);
    return challenge;
  }

  const hash = computeDeviceHash(fp);
  const label = computeDeviceLabel(fp);

  // 既に信頼済みデバイスとして登録されているか
  const rows = await db.select().from(schema.trustedDevices).where(
    and(
      eq(schema.trustedDevices.userId, user.id),
      eq(schema.trustedDevices.deviceHash, hash),
      isNull(schema.trustedDevices.revokedAt),
    ),
  ).limit(1);

  const known = rows[0];
  if (known) {
    // last_seen_at と IP を更新
    await db.update(schema.trustedDevices).set({
      lastSeenAt: new Date(),
      lastIp: ctx.ip ?? known.lastIp,
    }).where(eq(schema.trustedDevices.id, known.id));
    logAuthEvent({
      event: "user.device.trusted",
      userId: user.id,
      deviceLabel: label,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { trusted: true, anomalies: [], label };
  }

  // 未知のデバイス。過去のデバイスと比較して anomalies を抽出
  const anomalies = await detectAnomalies(user.id, fp, ctx.ip);
  const challenge = await issueChallenge(user, fp, ctx, anomalies);
  return challenge;
}

/**
 * 過去の信頼済みデバイス群と比較して、何が普段と異なるかを返す。
 */
async function detectAnomalies(
  userId: string,
  fp: DeviceFingerprint,
  ip: string | undefined,
): Promise<Anomaly[]> {
  const past = await db.select().from(schema.trustedDevices).where(
    and(
      eq(schema.trustedDevices.userId, userId),
      isNull(schema.trustedDevices.revokedAt),
    ),
  ).orderBy(desc(schema.trustedDevices.lastSeenAt)).limit(20);

  if (past.length === 0) return ["new_device"];

  const m = (fp.machine ?? {}) as Record<string, unknown>;
  const b = (fp.browser ?? {}) as Record<string, unknown>;
  const g = (fp.geo ?? {}) as Record<string, unknown>;

  const knownOs = new Set(past.map((d) => (d.machineInfo as Record<string, unknown>)?.os).filter(Boolean));
  const knownBrowser = new Set(past.map((d) => (d.browserInfo as Record<string, unknown>)?.browser).filter(Boolean));
  const knownCountry = new Set(past.map((d) => (d.geoInfo as Record<string, unknown>)?.country).filter(Boolean));
  const knownIps = new Set(past.map((d) => d.lastIp).filter((x): x is string => !!x));

  const anomalies: Anomaly[] = ["new_device"];
  if (m.os && !knownOs.has(m.os as string)) anomalies.push("new_os");
  if (b.browser && !knownBrowser.has(b.browser as string)) anomalies.push("new_browser");
  if (g.country && knownCountry.size > 0 && !knownCountry.has(g.country as string)) anomalies.push("new_location");
  if (ip && knownIps.size > 0 && !knownIps.has(ip)) anomalies.push("new_ip");

  return anomalies;
}

// ── 公開: チャレンジ発行 / 検証 ───────────────────────────────

interface StoredChallenge {
  userId: string;
  email: string | null;
  hash: string;
  label: string;
  fp: DeviceFingerprint;
  anomalies: Anomaly[];
  ip?: string;
  userAgent?: string;
  attempts: number;
  code: string;
  createdAt: number;
}

async function issueChallenge(
  user: { id: string; email: string | null },
  fp: DeviceFingerprint,
  ctx: { ip?: string; userAgent?: string },
  anomalies: Anomaly[],
): Promise<DeviceCheckResult> {
  const deviceToken = crypto.randomUUID();
  const code = generateNumericCode(CODE_LENGTH);
  const hash = computeDeviceHash(fp);
  const label = computeDeviceLabel(fp);

  const stored: StoredChallenge = {
    userId: user.id,
    email: user.email,
    hash,
    label,
    fp,
    anomalies,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    attempts: 0,
    code,
    createdAt: Date.now(),
  };

  await redis.set(`device_challenge:${deviceToken}`, JSON.stringify(stored), "EX", CHALLENGE_TTL);

  const channel = await sendVerificationCode(user.email, code, label, anomalies);

  logAuthEvent({
    event: "user.device.challenge",
    userId: user.id,
    deviceLabel: label,
    anomalies,
    channel,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return {
    trusted: false,
    deviceToken,
    anomalies,
    emailMasked: maskEmail(user.email),
    codeChannel: channel,
    label,
  };
}

export interface VerifyChallengeResult {
  ok: boolean;
  /** 検証に成功した場合のユーザー情報 */
  userId?: string;
  /** 残り試行回数 (失敗時のみ) */
  remainingAttempts?: number;
  error?: string;
}

/**
 * 確認コードを検証する。成功した場合は trusted_devices に登録する。
 */
export async function verifyChallenge(
  deviceToken: string,
  code: string,
): Promise<VerifyChallengeResult> {
  const key = `device_challenge:${deviceToken}`;
  const raw = await redis.get(key);
  if (!raw) return { ok: false, error: "Invalid or expired verification token" };

  const stored = JSON.parse(raw) as StoredChallenge;
  if (stored.attempts >= MAX_ATTEMPTS) {
    await redis.del(key);
    return { ok: false, error: "Too many attempts. Please sign in again." };
  }

  if (stored.code !== code.trim()) {
    stored.attempts += 1;
    const remaining = MAX_ATTEMPTS - stored.attempts;
    if (remaining <= 0) {
      await redis.del(key);
      logAuthEvent({
        event: "user.device.verify.failed",
        userId: stored.userId,
        deviceLabel: stored.label,
        error: "max_attempts_exceeded",
        ip: stored.ip,
      });
      return { ok: false, error: "Too many attempts. Please sign in again." };
    }
    await redis.set(key, JSON.stringify(stored), "KEEPTTL");
    logAuthEvent({
      event: "user.device.verify.failed",
      userId: stored.userId,
      deviceLabel: stored.label,
      error: "invalid_code",
      remainingAttempts: remaining,
      ip: stored.ip,
    });
    return { ok: false, error: "Invalid verification code", remainingAttempts: remaining };
  }

  // 検証成功 — チャレンジを破棄し、信頼済みデバイスとして登録
  await redis.del(key);
  await registerTrustedDevice(stored);
  logAuthEvent({
    event: "user.device.verify.success",
    userId: stored.userId,
    deviceLabel: stored.label,
    ip: stored.ip,
  });
  return { ok: true, userId: stored.userId };
}

async function registerTrustedDevice(stored: StoredChallenge): Promise<void> {
  const norm = normalize(stored.fp);
  const now = new Date();

  // 既存 (revoked かつ同じハッシュ) があれば再有効化、なければ新規挿入
  const existing = await db.select().from(schema.trustedDevices).where(
    and(
      eq(schema.trustedDevices.userId, stored.userId),
      eq(schema.trustedDevices.deviceHash, stored.hash),
      isNull(schema.trustedDevices.revokedAt),
    ),
  ).limit(1);

  if (existing[0]) {
    await db.update(schema.trustedDevices).set({
      lastSeenAt: now,
      lastIp: stored.ip ?? existing[0].lastIp,
      label: stored.label,
    }).where(eq(schema.trustedDevices.id, existing[0].id));
    return;
  }

  await db.insert(schema.trustedDevices).values({
    id: crypto.randomUUID(),
    userId: stored.userId,
    deviceHash: stored.hash,
    label: stored.label,
    machineInfo: norm.machine,
    browserInfo: norm.browser,
    geoInfo: norm.geo,
    lastIp: stored.ip,
    firstSeenAt: now,
    lastSeenAt: now,
  });
}

/**
 * 確認コードを再送する (Rate limit は呼び出し側で行う)。
 */
export async function resendChallengeCode(deviceToken: string): Promise<boolean> {
  const key = `device_challenge:${deviceToken}`;
  const raw = await redis.get(key);
  if (!raw) return false;
  const stored = JSON.parse(raw) as StoredChallenge;
  // 新しいコードを発行 (古いコードは無効化)
  stored.code = generateNumericCode(CODE_LENGTH);
  stored.attempts = 0;
  await redis.set(key, JSON.stringify(stored), "EX", CHALLENGE_TTL);
  await sendVerificationCode(stored.email, stored.code, stored.label, stored.anomalies);
  logAuthEvent({
    event: "user.device.challenge.resent",
    userId: stored.userId,
    deviceLabel: stored.label,
    ip: stored.ip,
  });
  return true;
}

// ── 内部: コード生成 / 送信 / マスク ──────────────────────────

function generateNumericCode(length: number): string {
  const max = 10 ** length;
  const n = crypto.randomInt(0, max);
  return n.toString().padStart(length, "0");
}

function maskEmail(email: string | null | undefined): string | undefined {
  if (!email) return undefined;
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const head = local.slice(0, 1);
  const tail = local.length > 2 ? local.slice(-1) : "";
  return `${head}***${tail}@${domain}`;
}

/**
 * 確認コードを送信する。
 * SES/SMTP どちらも mailer 経由。宛先が無い場合のみコンソールにフォールバックする。
 * 送信失敗は throw。
 */
async function sendVerificationCode(
  email: string | null,
  code: string,
  label: string,
  anomalies: Anomaly[],
): Promise<"email" | "console"> {
  const subject = `[${config.appName}] サインイン本人確認コード: ${code}`;
  const lines = [
    `${config.appName} へのサインインを検出しました。`,
    "",
    `デバイス: ${label}`,
    `差分: ${anomalies.join(", ") || "なし"}`,
    "",
    `本人確認コード: ${code}`,
    "",
    "このサインインに心当たりがない場合は、ただちにパスワードを変更してください。",
    "コードの有効期限は 10 分です。",
  ];
  const text = lines.join("\n");

  if (!email) {
    // 宛先不明 — テスト容易性のためコンソールに出す
    console.log(
      `[identity] verification code generated (no email)\n` +
      `  subject:  ${subject}\n` +
      lines.map((l) => `  body:     ${l}`).join("\n"),
    );
    return "console";
  }

  try {
    const result = await sendMail({ to: email, subject, text });
    console.log(`[identity] verification code sent via ${result.channel} to=${email} messageId=${result.messageId ?? "(none)"}`);
    return "email";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[identity] failed to send verification code to=${email}: ${msg}`);
    throw new Error(`Failed to send verification email: ${msg}`);
  }
}
