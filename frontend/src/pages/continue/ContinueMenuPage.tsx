/**
 * 引き継ぎメニュー (spec/plan/2026-10-15-account-federation-design.md §4)。
 *
 * 「パスキーで続ける」で利用者が押したログインが取消 / 候補なしで終わったときにだけ出す
 * (WebAuthn は「この端末に無い」と「取消」を区別できないので、自動起動の取消では出さない)。
 *
 *   おすすめ: 既存アカウントへこの端末のパスキーを追加 (連携は不要)
 *   ① ほかの端末のパスキーで入る … 外部認証器で入った PC では登録の案内を挟む (スキップ可)
 *   ② この端末をアカウントに引き継ぐ … 使っている端末と QR でつなぎ、この端末用のアカウントを作って連携する
 *   ③ はじめて使う … /start (名前 →「はじめる」)。独立した新しいアカウント
 *
 * Query: return (ログイン後の戻り先、Cernere 内のパス) / login (戻るログイン画面のパス)
 */

import { bodyTextStyle, pageStyle, panelStyle, panelTitleStyle, primaryButton, secondaryButton } from "../../components/security/panel-styles";
import { readReturnPath, safeReturnPath, startUrl } from "../onboarding/onboarding-return";
import { crossDeviceLoginUrl, federateJoinUrl } from "./continue-links";
import { passkeyEnrollmentUrl } from "../../lib/passkey-enrollment";

export function ContinueMenuPage() {
  const params = new URLSearchParams(window.location.search);
  const returnTo = readReturnPath(window.location.search);
  const loginPath = safeReturnPath(params.get("login") ?? `/login?${new URLSearchParams({ redirect: returnTo }).toString()}`);

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>パスキーでのログインが完了しませんでした</h1>
      <p style={bodyTextStyle}>この端末でどう続けるかを選んでください。</p>

      <div style={panelStyle}>
        <h2 style={panelTitleStyle}>この端末にパスキーを登録する（おすすめ）</h2>
        <p style={bodyTextStyle}>スマホなどで今のアカウントにログインした後、この端末の Windows Hello や Touch ID にパスキーを追加します。次回からスマホを使わずに入れます。アカウントの連携はあとで設定できます。</p>
        <button type="button" onClick={() => window.location.assign(passkeyEnrollmentUrl(returnTo))} style={primaryButton(false)}>この端末に登録する</button>
      </div>

      <div style={panelStyle}>
        <h2 style={panelTitleStyle}>① ほかの端末のパスキーで入る</h2>
        <p style={bodyTextStyle}>
          スマホなど、パスキーのある端末で QR を読んで今回だけ入ります。ブラウザの「スマートフォンまたは別のデバイスを使用」を選んでください。
          認証後にこの端末への登録を案内する場合があります。共用の端末では登録せずに進んでください。
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
