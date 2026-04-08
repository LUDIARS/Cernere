/** Cernere から返されるユーザー情報 */
export interface CernereUser {
  id: string;
  displayName: string;
  email: string;
  role: string;
}

/** アクセストークン + リフレッシュトークン */
export interface CernereTokens {
  accessToken: string;
  refreshToken: string;
}

/** 認証結果 */
export interface CernereAuthResult {
  user: CernereUser;
  tokens: CernereTokens;
}

/** postMessage で送信される認証メッセージ */
export interface CernereAuthMessage {
  type: "cernere:auth";
  authCode: string;
}

/** postMessage で送信されるエラーメッセージ */
export interface CernereAuthErrorMessage {
  type: "cernere:auth_error";
  error: string;
}

/** セッション保存の抽象インターフェース */
export interface AuthStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** CernereAuth の設定 */
export interface CernereAuthConfig {
  /** Cernere サーバーの URL (例: "https://cernere.ludiars.com") */
  cernereUrl: string;
  /** セッション保存先 (デフォルト: memoryStorage) */
  storage?: AuthStorage;
  /** 認証成功時のコールバック */
  onAuthSuccess?: (user: CernereUser, tokens: CernereTokens) => void;
  /** 認証失敗時のコールバック */
  onAuthError?: (error: Error) => void;
}

/** Popup ウィンドウのオプション */
export interface PopupOptions {
  width?: number;
  height?: number;
}
