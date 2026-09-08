/**
 * Device Credential のローテーション判定
 * (spec/plan/passkey-default-authentication.md §11.3 / §11.4)
 *
 * 設計の要点は「正常な再送」 と「盗用 replay」 を取り違えないこと。 二重起動・
 * 複数タブ・同時 401・通信断で旧 token が再提示されるのは日常的に起きるので、
 * それでユーザー全体を失効させるとアカウントが人質になる。 世代と rotation_id を
 * 持たせ、 判断できない場合だけパスキーへ戻す。
 *
 * このモジュールは DB も時刻も持たない純関数にしてある。 競合と応答消失という
 * 再現しにくい経路を、 実 DB 無しで網羅的にテストできるようにするため。
 * 実際の行ロック (SELECT ... FOR UPDATE) と更新は呼び出し側の責務。
 */

import {
  deriveNextSecret,
  computeSecretHash,
  secretHashEquals,
} from "./session-keys.js";
import { DEVICE_TOKEN_PREFIX } from "./device-token.js";

/** §11.4 のエラー契約。 message の解析ではなくこの code で分岐させる。 */
export type DeviceRotationErrorCode =
  | "DEVICE_CREDENTIAL_MISSING"
  | "DEVICE_CREDENTIAL_INVALID"
  | "DEVICE_CREDENTIAL_EXPIRED"
  | "DEVICE_CREDENTIAL_REVOKED"
  | "DEVICE_ROTATION_CONFLICT"
  | "PASSKEY_REQUIRED";

/** ローテーション判定に必要な行の状態。 */
export interface DeviceCredentialState {
  id: string;
  generation: number;
  currentSecretHash: string;
  previousSecretHash: string | null;
  previousValidUntil: Date | null;
  lastRotationId: string | null;
  lastRotatedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface RotationKeys {
  verifyKey: Buffer;
  rotateKey: Buffer;
}

export interface RotationInput {
  presentedSecret: string;
  /** クライアントが生成する 128 bit 以上の冪等キー。 成功保存まで同じ値を再利用する。 */
  rotationId: string;
  now: Date;
}

export type RotationDecision =
  /** 世代を進めず、 提示された secret をそのまま使い続ける (§11.3-4)。 */
  | { kind: "keep"; secret: string }
  /** 同じ rotation_id の再送。 現行世代の secret を導出し直して同じ応答を返す (§11.3-8)。 */
  | { kind: "replay"; secret: string }
  /** 次世代を発行する (§11.3-5..7)。 */
  | {
      kind: "rotate";
      secret: string;
      nextGeneration: number;
      nextSecretHash: string;
      /** 旧 secret を受け付ける期限。 */
      previousValidUntil: Date;
    }
  /** 判断不能・要再認証 (§11.3-9 / §11.3-10)。 */
  | { kind: "error"; code: DeviceRotationErrorCode };

/** ローテーション grace。 この窓の中では旧 secret も受け付ける。 */
export const ROTATION_GRACE_MS = 30_000;

/**
 * 提示された secret から次の状態を決める。
 *
 * 未知の secret では認証を拒否するだけで、DB 行は失効しない。 他端末や passkey を巻き込まない
 * (§11.3-10)。 「盗用かもしれない」 という確度だけで全体を落とすと、 実際には
 * 通信断だった場合にユーザーを締め出すだけになる。
 */
export function decideRotation(
  state: DeviceCredentialState,
  input: RotationInput,
  keys: RotationKeys,
): RotationDecision {
  if (state.revokedAt) return { kind: "error", code: "DEVICE_CREDENTIAL_REVOKED" };
  if (state.expiresAt.getTime() <= input.now.getTime()) {
    return { kind: "error", code: "DEVICE_CREDENTIAL_EXPIRED" };
  }

  const presentedHash = computeSecretHash(
    keys.verifyKey,
    DEVICE_TOKEN_PREFIX,
    state.id,
    input.presentedSecret,
  );

  if (secretHashEquals(presentedHash, state.currentSecretHash)) {
    // 直近 grace 内に既に回った行へ現行 secret が来た = 並行タブが少し前に回した直後。
    // ここで更に回すと、 まだ新 token を保存できていない他タブを弾いてしまう。
    if (
      state.lastRotatedAt &&
      input.now.getTime() - state.lastRotatedAt.getTime() < ROTATION_GRACE_MS
    ) {
      return { kind: "keep", secret: input.presentedSecret };
    }
    return rotate(state, input, keys);
  }

  if (state.previousSecretHash) {
    const withinGrace =
      state.previousValidUntil != null &&
      input.now.getTime() < state.previousValidUntil.getTime();
    if (withinGrace && secretHashEquals(presentedHash, state.previousSecretHash)) {
      // 同じ rotation_id なら「応答が届かなかった再送」。 現行世代を導出し直して
      // 同じ成功応答を返す。 raw token を保存しなくても冪等にできるのはこのため。
      if (state.lastRotationId && state.lastRotationId === input.rotationId) {
        return {
          kind: "replay",
          secret: deriveNextSecret(keys.rotateKey, state.id, state.generation, state.lastRotationId),
        };
      }
      // 別の rotation_id が grace 内に来た = 別プロセスが同時に回そうとしている。
      // 失効させず 409 で待たせる。 クライアントは先行完了を待って 1 回だけ再試行する。
      return { kind: "error", code: "DEVICE_ROTATION_CONFLICT" };
    }
  }

  // grace 外の旧 secret / 未知 secret。 当該資格情報を拒否し、パスキーへ戻す。
  return { kind: "error", code: "PASSKEY_REQUIRED" };
}

function rotate(
  state: DeviceCredentialState,
  input: RotationInput,
  keys: RotationKeys,
): RotationDecision {
  const nextGeneration = state.generation + 1;
  const secret = deriveNextSecret(keys.rotateKey, state.id, nextGeneration, input.rotationId);
  return {
    kind: "rotate",
    secret,
    nextGeneration,
    nextSecretHash: computeSecretHash(keys.verifyKey, DEVICE_TOKEN_PREFIX, state.id, secret),
    previousValidUntil: new Date(input.now.getTime() + ROTATION_GRACE_MS),
  };
}
