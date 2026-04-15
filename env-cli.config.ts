import type { EnvCliConfig } from "./packages/env-cli/src/types.js";

const config: EnvCliConfig = {
  name: "Cernere",

  /**
   * Docker Compose / アプリケーションが .env から読むインフラキー。
   * Infisical に同名キーがあればそちらを優先し、なければデフォルト値を使用。
   */
  infraKeys: {
    // ─── Docker Compose (PostgreSQL) ───────────────────────
    POSTGRES_USER: "cernere",
    POSTGRES_PASSWORD: "cernere",
    POSTGRES_DB: "cernere",
    POSTGRES_PORT: "5432",

    // ─── Docker Compose (Redis) ────────────────────────────
    REDIS_PORT: "6379",

    // ─── Application ───────────────────────────────────────
    DATABASE_URL: "postgres://cernere:cernere@localhost:5432/cernere",
    REDIS_URL: "redis://127.0.0.1:6379",
    LISTEN_ADDR: "0.0.0.0:8080",
    FRONTEND_URL: "http://localhost:5173",
    VITE_ALLOWED_HOSTS: "",

    // ─── JWT ───────────────────────────────────────────────
    JWT_SECRET: "cernere-dev-secret-change-in-production",

    // ─── GitHub OAuth ──────────────────────────────────────
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    GITHUB_REDIRECT_URI: "http://localhost:8080/auth/github/callback",

    // ─── Google OAuth ──────────────────────────────────────
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    GOOGLE_REDIRECT_URI: "http://localhost:8080/auth/google/callback",

    // ─── AWS ───────────────────────────────────────────────
    AWS_REGION: "ap-northeast-1",
    AWS_SNS_ENABLED: "false",
    AWS_SES_ENABLED: "false",
    AWS_SES_FROM_EMAIL: "noreply@example.com",
    APP_NAME: "Cernere",

    // ─── Mail (SMTP / MailHog for dev, SES for prod) ──────
    CERNERE_SMTP_HOST: "localhost",
    CERNERE_SMTP_PORT: "1025",
    CERNERE_SMTP_USER: "",
    CERNERE_SMTP_PASS: "",
    CERNERE_MAIL_FROM: "noreply@cernere.local",
    MAILHOG_SMTP_PORT: "1025",
    MAILHOG_UI_PORT: "8025",
  },

  defaultSiteUrl: "https://app.infisical.com",
  defaultEnvironment: "dev",
};

export default config;
