# 管理画面のメニュー整理と組織リーダー

決定: neco 2026-11-10 (Cernere の管理画面が分かりにくくなったための整理)。

## 1. メニュー

権限の判定は server が行う。メニューは表示の出し分けだけを持つ (`frontend/src/components/nav-items.ts`)。

| 見える人 | メニュー | route | 中身 |
|---|---|---|---|
| 全員 | データを登録しているサービス | `/` | 自分のデータが Cernere に登録されているサービスの確認 (起動ボタンは置かない) |
| 全員 | 自分のデータ | `/profile` | 名前・自己紹介・公開/非公開・顔認証の閲覧と修正 |
| 全員 | データの設定 | `/data-optout` | 各サービスに渡す権限とオプトアウト |
| 全員 | 端末とログイン | `/devices` | パスキー一覧/追加/削除、QR での別の端末の追加、リカバリー QR、ログイン中の端末、連携アカウント、MFA、アカウントの連携への入口、最近の出来事、通知先 |
| リーダー以上 | 組織 | `/organizations` | 自分の組織のメンバーと使うサービスの管理 |
| システム管理者 | サービス管理 | `/admin/services` | サービスの登録と編集 (旧 Dashboard) |
| システム管理者 | 組織の管理・審査・回復・OIDC・Cloudflare・Kiosk・拠点認証 | 既存 | 既存機能のまま |

- 管理者には一般段と管理者段の 2 段を出す。管理者段に「組織の管理」があるので、一般段の「組織」は出さない。
- 「利用許可」(`/access`) はメニューから外す。審査待ちの人は `AccessGate` が自動で案内する。
- 旧 `/security` は `/devices` へ redirect する (ログイン通知メールのリンク先を壊さない)。
- 「データを登録しているサービス」は `managed_project overview` の `inUse` (Cernere に登録された列に値がある) だけで判定する。各サービスが自分の中だけに持つデータは数えない。読み込み失敗は「登録なし」と区別してエラー表示する。

## 2. 組織ロール

| ロール | 順位 | できること |
|---|---|---|
| owner | 4 | すべて |
| admin / maintainer | 3 | メンバー管理、組織サービスの有効化・無効化、メール閲覧 (従来どおり) |
| leader | 2 | メンバーの追加・削除、member⇔leader の変更、組織サービスの有効化・無効化、メール閲覧 |
| member | 1 | 閲覧と自己退出 |

規則 (`server/src/org/role-policy.ts`):

- 自分より上位のロールは付けられない。上位のメンバーは変更・削除できない (以前は maintainer が owner を付与できた)。
- 組織の作成・名前変更・削除は従来どおりシステム管理者だけ。
- システム管理者は非メンバーでも全ロールを扱える。最初の leader はシステム管理者か owner が指名する。
- 顔認証の同意の管理 (`face-consent-guard`) に leader は含めない。
- `organization list` は各組織に `myRole` を添え、UI はどこかで leader 以上のときだけ「組織」を出す。

## 3. ログイン画面のヘルプ

`frontend/src/pages/composite/LoginHelp.tsx`。既存の仕組み (SPEC-DEVICE-PAIRING の QR ペアリング、
「スマホでログイン」、リカバリー QR) の使い方だけを案内し、新しい認証経路は作らない。
案内するメニュー名は `DEVICE_MENU_LABEL` (= 「端末とログイン」) で、メニュー定義と一致することをテストで確かめる。

## 4. テスト

- `server/tests/org/role-policy.test.ts`
- `server/tests/frontend/admin-menu.test.ts` (メニュー、server と frontend のロール規則の一致、登録サービスの絞り込み)
- `server/tests/frontend/login-help.test.ts`
