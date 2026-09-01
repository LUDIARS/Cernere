/**
 * メールアドレス不要のパスキー新規登録 ceremony。
 *
 *   1. api.passkeySignupBegin({ name, email? }) → { signupId, options }
 *   2. navigator.credentials.create()          (startRegistration)
 *   3. api.passkeySignupFinish({ signupId, response }) → CompositeAuthResponse (authCode)
 *
 * name だけでアカウントを作れる (email は任意)。 ユーザ行は Cernere 側で WebAuthn
 * 検証が通るまで作られないため、 途中離脱で空アカウントが残らない。
 */

import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import type { CompositeAuthResponse, CompositePasskeyApi } from "./auth-api.js";

export class PasskeyUnsupportedError extends Error {
  constructor() {
    super("This browser does not support passkeys (WebAuthn)");
    this.name = "PasskeyUnsupportedError";
  }
}

export interface PasskeySignupInput {
  name: string;
  /** 任意。 空文字は未指定として扱う */
  email?: string;
}

export async function runPasskeySignup(
  api: CompositePasskeyApi,
  input: PasskeySignupInput,
): Promise<CompositeAuthResponse> {
  if (!browserSupportsWebAuthn()) throw new PasskeyUnsupportedError();
  const name = input.name.trim();
  const email = input.email?.trim() || undefined;
  const begin = await api.passkeySignupBegin(email ? { name, email } : { name });
  const response = await startRegistration({ optionsJSON: begin.options });
  const finish = await api.passkeySignupFinish({ signupId: begin.signupId, response });
  if (finish.error) throw new Error(finish.error);
  return finish;
}
