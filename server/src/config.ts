/**
 * 環境変数設定
 */

import { randomBytes } from "node:crypto";

function env(key: string, fallback?: string): string {
  const val = process.env[key];
  if (val !== undefined) return val;
  if (fallback !== undefined) return fallback;
  throw new Error(`Required environment variable ${key} is not set`);
}

function envBool(key: string, fallback = false): boolean {
  const val = process.env[key];
  if (!val) return fallback;
  return val === "true" || val === "1";
}

function isProduction(): boolean {
  const e = process.env.CERNERE_ENV ?? process.env.APP_ENV ?? process.env.NODE_ENV ?? "";
  return e === "production" || e === "prod";
}

function isDevelopment(): boolean {
  if (isProduction()) return false;
  const e = process.env.CERNERE_ENV ?? process.env.APP_ENV ?? process.env.NODE_ENV ?? "";
  // デフォルト (env 未指定) は development とみなす
  return e === "" || e === "development" || e === "dev";
}

export const config = {
  databaseUrl: env("DATABASE_URL", "postgres://cernere:cernere@localhost:5432/cernere"),
  redisUrl: env("REDIS_URL", "redis://127.0.0.1:6379"),
  listenPort: parseInt(env("LISTEN_PORT", "8080"), 10),
  frontendUrl: env("FRONTEND_URL", "http://localhost:5173"),

  // ── 外部到達 URL / OIDC issuer ────────────────────────────
  // publicUrl は「外部 (Cloudflare Access 等の RP / ブラウザ) から Cernere
  // サーバーに到達する URL」。 OIDC の各エンドポイント (authorize/token/
  // userinfo/jwks) と discovery の issuer はこの値を基準に組み立てる。
  // リバースプロキシ配下では LISTEN_PORT ではなく公開ホストを指定すること。
  publicUrl: env("CERNERE_PUBLIC_URL", `http://localhost:${env("LISTEN_PORT", "8080")}`)
    .replace(/\/+$/, ""),
  // OIDC issuer。 既定は publicUrl と同じ。 discovery の "issuer" と
  // id_token の "iss" claim はこの値になる (末尾スラッシュ無し)。
  oidcIssuer: env("CERNERE_OIDC_ISSUER",
    env("CERNERE_PUBLIC_URL", `http://localhost:${env("LISTEN_PORT", "8080")}`))
    .replace(/\/+$/, ""),

  // GitHub OAuth
  githubClientId: env("GITHUB_CLIENT_ID", ""),
  githubClientSecret: env("GITHUB_CLIENT_SECRET", ""),
  githubRedirectUri: env("GITHUB_REDIRECT_URI", "http://localhost:8080/auth/github/callback"),

  // Google OAuth
  googleClientId: env("GOOGLE_CLIENT_ID", ""),
  googleClientSecret: env("GOOGLE_CLIENT_SECRET", ""),
  googleRedirectUri: env("GOOGLE_REDIRECT_URI", "http://localhost:8080/auth/google/callback"),

  // JWT
  jwtSecret: (() => {
    const secret = process.env.JWT_SECRET;
    if (secret) return secret;
    if (isProduction()) {
      throw new Error("JWT_SECRET must be set in production environment");
    }
    // M-2: dev フォールバックを既知のハードコード文字列にすると、 環境変数 1 本の
    // 設定ミスで「既知 secret で署名された token が通る」状態になる。 プロセス起動毎に
    // ランダム生成し、 dev 環境間でも token を共有させない (再起動で全 token が無効化)。
    console.warn("[config] JWT_SECRET is not set — generated an ephemeral dev secret (tokens reset on restart)");
    return randomBytes(32).toString("hex");
  })(),

  // AWS MFA
  awsRegion: env("AWS_REGION", "ap-northeast-1"),
  awsSnsEnabled: envBool("AWS_SNS_ENABLED"),
  awsSesEnabled: envBool("AWS_SES_ENABLED"),
  awsSesFromEmail: env("AWS_SES_FROM_EMAIL", "noreply@example.com"),
  appName: env("APP_NAME", "Cernere"),

  // Mail (SMTP). SES が有効ならそちらを優先。
  smtpHost: env("CERNERE_SMTP_HOST", "localhost"),
  smtpPort: parseInt(env("CERNERE_SMTP_PORT", "1025"), 10),
  smtpUser: env("CERNERE_SMTP_USER", ""),
  smtpPass: env("CERNERE_SMTP_PASS", ""),
  mailFrom: env("CERNERE_MAIL_FROM", "noreply@cernere.local"),

  // Identity (device) verification を完全に off にする dev/緊急用スイッチ。
  // true のとき checkDevice は常に trusted を返し、 確認コードのメール送信を行わない。
  // 本番では絶対に true にしてはいけない (isProduction ガードあり)。
  identityVerificationDisabled: (() => {
    const raw = envBool("CERNERE_IDENTITY_VERIFICATION_DISABLED");
    if (raw && isProduction()) {
      throw new Error(
        "CERNERE_IDENTITY_VERIFICATION_DISABLED=true is not allowed in production",
      );
    }
    return raw;
  })(),

  isHttps: env("FRONTEND_URL", "http://localhost:5173").startsWith("https://"),
  isProduction: isProduction(),
  isDevelopment: isDevelopment(),

  // ── WebAuthn / Passkey ────────────────────────────────────
  // RP ID は eTLD+1 (例: cernere.example.com → cernere.example.com、
  // または親ドメイン example.com)。 ブラウザは window.location.origin を見て
  // RP ID がそのサブドメインか否かをチェックする。
  // 既定は FRONTEND_URL のホスト名から自動。
  webauthnRpName:
    env("WEBAUTHN_RP_NAME", env("APP_NAME", "Cernere")),
  webauthnRpId:
    env("WEBAUTHN_RP_ID",
      (() => {
        const u = env("FRONTEND_URL", "http://localhost:5173");
        try { return new URL(u).hostname; } catch { return "localhost"; }
      })(),
    ),
  // 受け付ける origin (= 通常は FRONTEND_URL と同じ。 複数許可は comma 区切り)
  webauthnOrigins:
    env("WEBAUTHN_ORIGINS", env("FRONTEND_URL", "http://localhost:5173"))
      .split(",").map(s => s.trim()).filter(Boolean),
} as const;
