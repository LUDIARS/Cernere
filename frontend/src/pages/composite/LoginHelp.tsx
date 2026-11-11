import { bodyTextStyle } from "../../components/security/panel-styles";

/**
 * ログイン画面のヘルプ。端末の切り替えは既存の仕組み (SPEC-DEVICE-PAIRING の QR ペアリング、
 * スマホでログイン、リカバリー QR) への案内だけを持ち、新しい認証経路は作らない。
 */
export interface HelpTopic {
  title: string;
  steps: string[];
  /** この画面の「スマホでログイン」ボタンを使う手順。ボタンが出ない画面 (パスキー登録済みの端末) では出さない。 */
  usesPhoneLoginButton?: boolean;
}

/** 端末の追加・切り替えを行うメニューの表示名。AppLayout のメニュー名と揃える。 */
export const DEVICE_MENU_LABEL = "端末とログイン";

export const DEVICE_SWITCH_HELP: HelpTopic[] = [
  { title: "PC からスマホへ", steps: [
    `ログイン済みの PC で「${DEVICE_MENU_LABEL}」を開き、「別の端末を追加する」で QR を出します。`,
    "スマホのカメラで QR を読み、パスキーを作ります。",
    "スマホに出た 4 桁の番号を PC に入れて承認します。",
  ] },
  { title: "スマホから PC へ", usesPhoneLoginButton: true, steps: [
    "PC のこの画面で「スマホでログイン」を押します。",
    "PC に出た QR をスマホで読み、スマホのパスキーで確認します。",
    "ログイン後に出る案内から、PC にパスキーを登録します。",
  ] },
  { title: "PC を買い替えたとき", usesPhoneLoginButton: true, steps: [
    "古い PC が使えるうちに、「PC からスマホへ」の手順でスマホを追加します。",
    "新しい PC で「スマホから PC へ」の手順を行います。",
  ] },
  { title: "スマホを買い替えたとき", steps: [
    `ログイン済みの PC か古いスマホで「${DEVICE_MENU_LABEL}」を開き、「別の端末を追加する」で QR を出します。`,
    "新しいスマホで QR を読み、新しいスマホに出た 4 桁の番号を元の端末に入れて承認します。",
  ] },
  { title: "すべての端末をなくしたとき", steps: [
    "下の「アカウントを復旧する」へ進みます。",
    "保存しておいたリカバリー QR を読み込むと、24 時間後に復旧が完了します。",
  ] },
];

const topicTitleStyle = { fontWeight: 600, margin: "0.75rem 0 0.25rem" };
const stepsStyle = { margin: 0, paddingLeft: "1.25rem" };

/** 表示する手順。phoneLoginAvailable=false の画面ではボタンを使う手順を除く。 */
export function visibleHelpTopics(phoneLoginAvailable: boolean): HelpTopic[] {
  return DEVICE_SWITCH_HELP.filter((topic) => phoneLoginAvailable || !topic.usesPhoneLoginButton);
}

export function LoginHelp({ phoneLoginAvailable = true }: { phoneLoginAvailable?: boolean }) {
  return <details style={{ marginBottom: "1rem", fontSize: "0.8rem" }}>
    <summary style={{ width: "fit-content", marginLeft: "auto", cursor: "pointer", color: "var(--accent)" }}>ヘルプ</summary>
    <div style={{ ...bodyTextStyle, marginTop: "0.75rem" }}>
      <p>はじめて使う場合は、新規アカウントを登録します。</p>
      <p>すでにアカウントがある場合は、スマホのパスキーでログインできます。ログイン後、この端末を追加する案内が表示されます。</p>
      <p>パスキーが使えない場合は、下の「アカウントを復旧する」へ進んでください。</p>
      <p style={topicTitleStyle}>端末を切り替えるとき（QR）</p>
      <p>QR は他の人に見せたり、写真を送ったりしないでください。</p>
      {visibleHelpTopics(phoneLoginAvailable).map((topic) => <div key={topic.title}>
        <p style={topicTitleStyle}>{topic.title}</p>
        <ol style={stepsStyle}>{topic.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      </div>)}
    </div>
  </details>;
}
