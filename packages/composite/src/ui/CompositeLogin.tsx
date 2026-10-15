/**
 * <CompositeLogin>
 *
 * サービス (Schedula 等) の SPA に埋め込んで使う Cernere 認証 UI。Cernere 自身の
 * /login と /composite/login も同じカードを描画する。
 *
 * ログインはパスキーのみで、登録とログインを区別しない (SPEC-PASSKEY-CONTINUE):
 *   1. 画面を開いた直後に usernameless のパスキー ceremony を自動起動する
 *   2. 取消・パスキー無しのときは「アカウントが無い」と言わず、次の順で選択肢を出す
 *      再試行 / 他の端末にある (ブラウザのクロスデバイス QR・リカバリー QR) / 新しく始める
 *   3. 新しく始めるは onCreateAccount に委ねる。名前・リカバリー QR・別端末の追加を
 *      Cernere の画面で済ませるため、カード内ではアカウントを作らない
 *
 * 通信は利用側が提供する authApi (サービス backend → project WS、または Cernere の REST) に委ねる。
 *
 * Usage (Schedula):
 *   <CompositeLogin authApi={myAuthApi} onAuthCode={(code) => ...}
 *     onCreateAccount={() => openCernerePopup()} recoverUrl="https://cernere.example/recover" />
 */

import { useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import type { CompositeAuthApi, CompositeAuthResponse } from "./auth-api.js";
import { LoginDivider } from "./LoginDivider.js";
import { DEFAULT_LABELS, type CompositeLoginLabels } from "./login-labels.js";
import { hintStyle, subtleLinkStyle } from "./login-styles.js";
import { PasskeyLoginSection } from "./PasskeyLoginSection.js";
import { passkeyAbortOutcome } from "./passkey-continue.js";
import { usePasskeyLogin } from "./usePasskeyLogin.js";

// 旧 import 経路 (./CompositeLogin.js からの型 import) を壊さないための再 export。
export type { CompositeAuthApi, CompositeAuthResponse } from "./auth-api.js";

export interface CompositeLoginProps {
  /** 認証 API 実装 (サービス側が提供) */
  authApi: CompositeAuthApi;
  /** 認証成功時のコールバック (auth_code を受け取る) */
  onAuthCode: (authCode: string) => void;
  /**
   * 「新しく始める」を押したとき。Cernere の画面 (popup / 同一窓) でアカウントを作らせる。
   * 渡さない場合は新規作成の導線を出さない。
   */
  onCreateAccount?: () => void | Promise<void>;
  /** リカバリー QR で戻す画面 (Cernere の /recover)。渡さない場合はリンクを出さない */
  recoverUrl?: string;
  /** 表示テキストの上書き (i18n) */
  labels?: Partial<CompositeLoginLabels>;
  /** カード内の主ボタン下に差し込む代替導線。 */
  alternatives?: ReactNode;
  /** alternatives の上に出す区切り文言 (既定は orContinueWith) */
  alternativesLabel?: string;
  /**
   * 画面表示時にパスキー ceremony を自動起動してよいか (既定 true)。
   * 送信先検証や silent SSO が先に決着すべき画面は、決着後に true へ切り替える。
   */
  passkeyAutoStart?: boolean;
  /** 追加スタイル (カード外側) */
  className?: string;
  style?: CSSProperties;
}

const errorStyle: CSSProperties = {
  background: "rgba(248, 81, 73, 0.1)",
  border: "1px solid var(--red, #ef4444)",
  borderRadius: "4px",
  padding: "0.5rem 0.75rem",
  marginBottom: "1rem",
  fontSize: "0.85rem",
  color: "var(--red, #ef4444)",
};

/**
 * @implements SPEC-PASSKEY-CONTINUE
 * @implements SPEC-COMPOSITE-PASSKEY-AUTOSTART
 */
export function CompositeLogin(props: CompositeLoginProps): ReactElement {
  const l: CompositeLoginLabels = { ...DEFAULT_LABELS, ...props.labels };
  const { authApi, onAuthCode, onCreateAccount, recoverUrl, passkeyAutoStart = true } = props;
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const handleResponse = (r: CompositeAuthResponse) => {
    if (r.authCode) {
      onAuthCode(r.authCode);
      return;
    }
    // 何も進まない応答で黙って止まらない (「ボタンを押しても反応が無い」 になる)
    throw new Error(r.error ?? "Unexpected authentication response");
  };

  // 入口は「パスキーで続ける」1 つ。押してパスキーが無ければ、そのまま作成ダイアログへ進む
  // (passkey-continue.ts)。アカウントができるのは作成を完了したときだけ。
  const startCreate = async () => {
    if (!onCreateAccount) return;
    setError("");
    setCreating(true);
    try {
      await onCreateAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start account creation");
    } finally {
      setCreating(false);
    }
  };

  const passkey = usePasskeyLogin({
    api: authApi,
    autoStartReady: passkeyAutoStart,
    onResponse: (r) => {
      try { handleResponse(r); } catch (err) { setError(err instanceof Error ? err.message : "Authentication failed"); }
    },
    onError: setError,
    onManualAbort: () => {
      if (passkeyAbortOutcome({ manual: true, canCreate: Boolean(onCreateAccount) }) === "create") void startCreate();
    },
  });

  // 取消・パスキー無しの後にだけ、別端末・リカバリーの案内を出す。
  const showChoices = passkey.phase === "fallback" || passkey.phase === "unsupported";

  return (
    <div
      className={props.className}
      style={{
        width: "100%",
        maxWidth: 400,
        background: "var(--bg-surface, #fff)",
        border: "1px solid var(--border, #ccc)",
        borderRadius: "var(--radius, 8px)",
        padding: "2rem",
        boxSizing: "border-box",
        ...props.style,
      }}
    >
      <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}>{l.title}</h1>
        <p style={{ color: "var(--text-muted, #888)", fontSize: "0.85rem" }}>{l.subtitle}</p>
      </div>

      {error && <div role="alert" style={errorStyle}>{error}</div>}

      <PasskeyLoginSection
        phase={passkey.phase}
        hasAttempted={passkey.hasAttempted}
        hasError={Boolean(error)}
        onStart={() => { setError(""); passkey.start(); }}
        labels={l}
      />

      {showChoices && (
        <div style={{ marginTop: "1.25rem" }}>
          <p style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: "0.25rem" }}>{l.otherDeviceTitle}</p>
          <p style={hintStyle}>{l.otherDeviceHint}</p>
          {recoverUrl && (
            <p style={{ ...hintStyle, marginTop: "0.5rem" }}>
              <a href={recoverUrl} style={subtleLinkStyle}>{l.recoverWithQr}</a>
            </p>
          )}
          {onCreateAccount && (
            <p style={{ ...hintStyle, marginTop: "0.5rem" }}>{creating ? l.processing : l.createAccountHint}</p>
          )}
        </div>
      )}

      {props.alternatives && (
        <>
          <LoginDivider label={props.alternativesLabel ?? l.orContinueWith} />
          {props.alternatives}
        </>
      )}
    </div>
  );
}
