/**
 * 引き継ぎメニュー (spec/plan/2026-10-15-account-federation-design.md §4)。
 *
 * 「パスキーで続ける」で利用者が押したログインが取消 / 候補なしで終わったときにだけ出す
 * (WebAuthn は「この端末に無い」と「取消」を区別できないので、自動起動の取消では出さない)。
 *
 *   ① ほかの端末のパスキーで入る … ブラウザの「スマートフォンまたは別のデバイスを使用」(QR) で今回だけ入る
 *   ② この端末をアカウントに引き継ぐ … 使っている端末と QR でつなぎ、この端末用のアカウントを作って連携する
 *   ③ はじめて使う … /start (名前 →「はじめる」)。独立した新しいアカウント
 *
 * Query: return (ログイン後の戻り先、Cernere 内のパス) / login (戻るログイン画面のパス)
 */

import { bodyTextStyle, pageStyle, panelStyle, panelTitleStyle, primaryButton, secondaryButton } from "../../components/security/panel-styles";
import { readReturnPath, safeReturnPath, startUrl } from "../onboarding/onboarding-return";
import { crossDeviceLoginUrl, federateJoinUrl } from "./continue-links";

export function ContinueMenuPage() {
  const params = new URLSearchParams(window.location.search);
  const returnTo = readReturnPath(window.location.search);
  const loginPath = safeReturnPath(params.get("login") ?? `/login?${new URLSearchParams({ redirect: returnTo }).toString()}`);

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>この端末には Cernere のパスキーが見つかりませんでした</h1>
      <p style={bodyTextStyle}>この端末でどう続けるかを選んでください。</p>

      <div style={panelStyle}>
        <h2 style={panelTitleStyle}>① ほかの端末のパスキーで入る</h2>
        <p style={bodyTextStyle}>
          スマホなど、パスキーのある端末で QR を読んで今回だけ入ります。ブラウザの「スマートフォンまたは別のデバイスを使用」を選んでください。
          この端末にはパスキーを残しません。
        </p>
        <button type="button" onClick={() => window.location.assign(crossDeviceLoginUrl(loginPath))} style={primaryButton(false)}>
          ほかの端末で入る
        </button>
      </div>

      <div style={panelStyle}>
        <h2 style={panelTitleStyle}>② この端末をアカウントに引き継ぐ</h2>
        <p style={bodyTextStyle}>
          いま使っている端末と QR でつなぎ、この端末用のパスキーを作ります。名前やサービスでの記録は、いま使っているアカウントと同じものが使われます。
        </p>
        <button type="button" onClick={() => window.location.assign(federateJoinUrl(returnTo))} style={primaryButton(false)}>
          この端末を引き継ぐ
        </button>
      </div>

      <div style={panelStyle}>
        <h2 style={panelTitleStyle}>③ はじめて使う</h2>
        <p style={bodyTextStyle}>新しいアカウントを作ります。ほかの端末のアカウントとは別のものになります。</p>
        <button type="button" onClick={() => window.location.assign(startUrl(returnTo))} style={secondaryButton(false)}>
          はじめて使う
        </button>
      </div>

      <button type="button" onClick={() => window.location.assign(loginPath)} style={{ ...secondaryButton(false), marginTop: "1rem" }}>
        ログインに戻る
      </button>
    </main>
  );
}
