/**
 * WebAuthn の RP 設定と登録時の認証器ポリシー。
 * signup / profile 追加 / 端末追加 (pairing) / リカバリー QR の全登録経路で共通に使う。
 */

import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";

import { config } from "../config.js";
import { mergeWebauthnOrigins } from "./webauthn-origins.js";

export const RP_NAME = config.webauthnRpName;
export const RP_ID = config.webauthnRpId;
// 埋め込み SDK を描画する first-party サービスの origin でも ceremony が走るため、
// composite の許可 origin を expectedOrigin に合流させる (auth/webauthn-origins.ts)。
export const ORIGINS = mergeWebauthnOrigins(config.webauthnOrigins, config.compositeAllowedOrigins);
/**
 * アカウントの作成・端末追加・回復の ceremony は Cernere 自身の origin でだけ受け付ける
 * (SPEC-PASSKEY-CONTINUE)。埋め込み先サービスの origin (XSS を含む) からはログインしかさせない。
 */
export const CERNERE_ORIGINS = config.webauthnOrigins;
export const CHALLENGE_TTL_SEC = 5 * 60;

/**
 * 登録時の認証器ポリシー (3 経路 = signup / profile 追加 / 新端末登録 で共通)。
 *
 *   - residentKey "required"
 *       usernameless (メール未入力) ログインには discoverable credential が要る。
 *       "preferred" だと非 discoverable が作られ得て、 認証器が候補を出せない。
 *   - userVerification "required"
 *       出席チェックイン (Ostiarius) が assertion を userVerification:'required' で
 *       検証するため、 登録時点で UV (生体/PIN) を必須化して整合させる。 端末貸し
 *       対策が設計の核なので、 ここはセキュア方向に寄せる。
 */
export const REGISTRATION_AUTHENTICATOR_SELECTION = {
  residentKey: "required",
  userVerification: "required",
} as const;

/** DB の transports 列 (jsonb) を WebAuthn の transports に戻す。 */
export function transportsOf(value: unknown): AuthenticatorTransportFuture[] | undefined {
  return Array.isArray(value) ? (value as AuthenticatorTransportFuture[]) : undefined;
}
