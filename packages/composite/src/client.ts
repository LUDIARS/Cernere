import type {
  CernereAuthConfig,
  CernereAuthResult,
  CernereAuthMessage,
  CernereAuthErrorMessage,
  CernereUser,
  CernereTokens,
  AuthStorage,
  PopupOptions,
} from "./types.js";
import { createMemoryStorage } from "./storage.js";

const KEY_ACCESS_TOKEN = "accessToken";
const KEY_REFRESH_TOKEN = "refreshToken";
const KEY_USER = "user";
const KEY_REDIRECT_RETURN = "redirectReturn";

type AuthMessageEvent = CernereAuthMessage | CernereAuthErrorMessage;

/**
 * Cernere Composite 認証クライアント。
 * Popup / Redirect の2つのフローでログインし、トークンを管理する。
 */
export class CernereAuth {
  private readonly cernereUrl: string;
  private readonly storage: AuthStorage;
  private readonly onAuthSuccess?: CernereAuthConfig["onAuthSuccess"];
  private readonly onAuthError?: CernereAuthConfig["onAuthError"];

  private user: CernereUser | null = null;
  private listeners = new Set<() => void>();

  constructor(config: CernereAuthConfig) {
    this.cernereUrl = config.cernereUrl.replace(/\/$/, "");
    this.storage = config.storage ?? createMemoryStorage();
    this.onAuthSuccess = config.onAuthSuccess;
    this.onAuthError = config.onAuthError;

    this.restoreSession();
  }

  // ─── Popup Flow ────────────────────────────────────────────

  /**
   * Popup ウィンドウで Cernere ログインを開始する。
   * Promise は認証完了 (成功 or 失敗) で解決される。
   */
  loginWithPopup(options?: PopupOptions): Promise<CernereAuthResult> {
    const width = options?.width ?? 480;
    const height = options?.height ?? 640;
    const left = Math.round(window.screenX + (window.innerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.innerHeight - height) / 2);

    const origin = window.location.origin;
    const url = `${this.cernereUrl}/composite/login?origin=${encodeURIComponent(origin)}`;

    const popup = window.open(
      url,
      "cernere-login",
      `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`,
    );

    if (!popup) {
      const err = new Error("Failed to open login popup. Check popup blocker settings.");
      this.onAuthError?.(err);
      return Promise.reject(err);
    }

    return new Promise<CernereAuthResult>((resolve, reject) => {
      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        clearInterval(pollTimer);
      };

      const onMessage = async (event: MessageEvent<AuthMessageEvent>) => {
        if (event.origin !== this.cernereUrl) return;

        const data = event.data;
        if (!data || typeof data !== "object") return;

        if (data.type === "cernere:auth_error") {
          cleanup();
          popup.close();
          const err = new Error(data.error);
          this.onAuthError?.(err);
          reject(err);
          return;
        }

        if (data.type === "cernere:auth" && data.authCode) {
          cleanup();
          popup.close();
          try {
            const result = await this.exchangeCode(data.authCode);
            resolve(result);
          } catch (e) {
            reject(e);
          }
        }
      };

      // Popup が手動で閉じられた場合の検知
      const pollTimer = setInterval(() => {
        if (popup.closed) {
          cleanup();
          const err = new Error("Login popup was closed.");
          this.onAuthError?.(err);
          reject(err);
        }
      }, 500);

      window.addEventListener("message", onMessage);
    });
  }

  // ─── Redirect Flow ─────────────────────────────────────────

  /**
   * ブラウザをリダイレクトして Cernere ログインを開始する。
   * @param callbackUrl 認証後に戻る URL (デフォルト: 現在の URL)
   */
  loginWithRedirect(callbackUrl?: string): void {
    const callback = callbackUrl ?? window.location.href;
    this.storage.set(KEY_REDIRECT_RETURN, window.location.href);
    const url = `${this.cernereUrl}/composite/login?redirect_uri=${encodeURIComponent(callback)}`;
    window.location.href = url;
  }

  /**
   * Redirect コールバック後に呼び出す。URL の ?code= パラメータを処理する。
   * 認証がなかった場合は null を返す。
   */
  async handleRedirectCallback(): Promise<CernereAuthResult | null> {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (!code) return null;

    // URL からパラメータを除去
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, "", cleanUrl);

    try {
      return await this.exchangeCode(code);
    } catch (e) {
      this.onAuthError?.(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }

  // ─── Session ───────────────────────────────────────────────

  getUser(): CernereUser | null {
    return this.user;
  }

  getAccessToken(): string | null {
    return this.storage.get(KEY_ACCESS_TOKEN);
  }

  isAuthenticated(): boolean {
    return this.user !== null && this.getAccessToken() !== null;
  }

  /**
   * アクセストークンをリフレッシュする。
   * 成功時 true、失敗時 false を返す (失敗時はセッションをクリア)。
   */
  async refreshToken(): Promise<boolean> {
    const refreshToken = this.storage.get(KEY_REFRESH_TOKEN);
    if (!refreshToken) return false;

    try {
      const res = await fetch(`${this.cernereUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });

      if (!res.ok) {
        this.clearSession();
        return false;
      }

      const data = await res.json();
      this.storage.set(KEY_ACCESS_TOKEN, data.accessToken);
      if (data.refreshToken) {
        this.storage.set(KEY_REFRESH_TOKEN, data.refreshToken);
      }
      return true;
    } catch {
      this.clearSession();
      return false;
    }
  }

  /**
   * 保存済みトークンで認証状態を復元する。
   * 呼び出し元で await して初期化完了を待つ。
   */
  async initialize(): Promise<boolean> {
    const token = this.getAccessToken();
    if (!token) return false;

    try {
      const res = await fetch(`${this.cernereUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const me = await res.json();
        this.user = { id: me.id, displayName: me.displayName, email: me.email ?? "", role: me.role };
        this.notify();
        return true;
      }

      // 401 ならリフレッシュを試みる
      if (res.status === 401) {
        const refreshed = await this.refreshToken();
        if (refreshed) return this.initialize();
      }

      this.clearSession();
      return false;
    } catch {
      this.clearSession();
      return false;
    }
  }

  logout(): void {
    this.clearSession();
  }

  /** 状態変更のリスナーを登録。解除関数を返す。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ─── Internal ──────────────────────────────────────────────

  private async exchangeCode(code: string): Promise<CernereAuthResult> {
    const res = await fetch(`${this.cernereUrl}/api/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`Auth exchange failed: ${res.status} ${body}`);
      this.onAuthError?.(err);
      throw err;
    }

    const data = await res.json();
    const user: CernereUser = {
      id: data.user.id,
      displayName: data.user.displayName,
      email: data.user.email ?? "",
      role: data.user.role,
    };
    const tokens: CernereTokens = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    };

    this.saveSession(user, tokens);
    this.onAuthSuccess?.(user, tokens);
    return { user, tokens };
  }

  private saveSession(user: CernereUser, tokens: CernereTokens): void {
    this.storage.set(KEY_ACCESS_TOKEN, tokens.accessToken);
    this.storage.set(KEY_REFRESH_TOKEN, tokens.refreshToken);
    this.storage.set(KEY_USER, JSON.stringify(user));
    this.user = user;
    this.notify();
  }

  private clearSession(): void {
    this.storage.remove(KEY_ACCESS_TOKEN);
    this.storage.remove(KEY_REFRESH_TOKEN);
    this.storage.remove(KEY_USER);
    this.user = null;
    this.notify();
  }

  private restoreSession(): void {
    const raw = this.storage.get(KEY_USER);
    if (raw) {
      try {
        this.user = JSON.parse(raw);
      } catch {
        this.user = null;
      }
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
