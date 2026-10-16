# 2 台目の端末のログインとアカウント連携 (フェデレーション) 設計

- 日付: 2026-10-15
- 依頼 (neco):
  「2台目のログインだけど、パスキーでログイン→登録可否を調べる→登録されている場合ログイン成功→登録されていない場合、
  QRでスマホからログインできるようにしたり、スマホの場合はカメラを起動出来たりする。引継ぎライクなフェデレーションメニューを用意する。
  2台目のアカウントそのものは新規登録されていて、実態はフェデレーションである。フェデレーションは後からでもできる。
  だれを主にするかは設定で選べる。」
- 決定 (neco 2026-10-15): サービスに渡す利用者番号は **連携ごとの固定番号**。どのアカウントで入っても同じ番号を渡し、
  主を切り替えてもサービス側のデータは途切れない。名前などの表示は主のものを使う。
- 前提: パスキーのみ (2026-10-14)、入口は「パスキーで続ける」1 つ (#3070)、/start で名前 →「はじめる」でアカウント作成 (#3074)、
  許可制 (068/071)、権限確認 (consent)。

## 1. 用語

| 語 | 意味 |
|---|---|
| アカウント | `users` の 1 行。パスキーを持つ。端末ごとに作られる |
| 連携 (federation) | 複数のアカウントのまとまり。`account_federations` の 1 行 |
| 連携番号 (subject) | サービスに渡す固定の利用者番号。連携を作ったときの **最初のアカウントの user id** をそのまま使う (既存のサービスデータを壊さない) |
| 主 (primary) | 連携のうち、名前・プロフィール・許可状態の基準にするアカウント。設定で切り替えられる |

連携していないアカウントの subject は自分の user id (今と同じ)。

## 2. データ

migration (番号は着手時に採番。DROP なし):

```sql
CREATE TABLE IF NOT EXISTS account_federations (
    id               UUID PRIMARY KEY,
    subject_id       UUID NOT NULL UNIQUE,      -- サービスに渡す固定番号 (= 最初のアカウントの user id。変えない)
    primary_user_id  UUID NOT NULL REFERENCES users(id),
    revision         INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS account_federation_members (
    federation_id    UUID NOT NULL REFERENCES account_federations(id) ON DELETE CASCADE,
    user_id          UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,  -- 1 アカウントは 1 連携まで
    joined_via       TEXT NOT NULL CHECK (joined_via IN ('founder', 'qr_new_device', 'qr_existing_account')),
    joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (federation_id, user_id)
);
CREATE TABLE IF NOT EXISTS account_federation_events (   -- 監査 (追記のみ)
    id UUID PRIMARY KEY, federation_id UUID NOT NULL, actor_user_id UUID, target_user_id UUID,
    action TEXT NOT NULL CHECK (action IN ('create', 'join', 'leave', 'remove', 'set_primary')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

上限: 1 連携 10 アカウント。

## 3. 番号の解決 (サービス境界)

`server/src/federation/subject.ts` に `resolveServiceSubject(userId) → { subject, primaryUserId }` を置き、
**サービスへ利用者を渡す全ての口** をこれで通す。Cernere 内部 (パスキー・セッション・端末管理) は各アカウントの user id のまま。

| 口 | 変更 |
|---|---|
| service 向け authCode / exchange 応答の `user.id` | subject。名前・email・role は主のもの |
| user×project token (PASETO) の `sub` | subject |
| OIDC の `sub` / userinfo | subject (claims は主) |
| project user data (`project_data_<slug>.user_id`)・`ensureUserProjectRow` | subject |
| 権限確認の同意記録・サインアップ入力 (user_service_consents 等) | subject |
| サービスからの profile.get / identity claim の対象 user | subject → 主の値を返す |
| service token・relay の宛先 user | subject で受け、連携の全アカウントのセッションへ配る |

許可状態 (068): サービスへ入れるかは **主の access_status** で決める。どのアカウントも locked なら、そのアカウントでのログインは拒否。
主が locked なら連携全体がサービスへ入れない。

## 4. 2 台目の端末のログイン (引き継ぎメニュー)

「パスキーで続ける」(#3070) で利用者が押したログインが取消 / 候補なしで終わったとき、今は /start へ進む。
これを **引き継ぎメニュー** (`/continue`) に置き換える。WebAuthn は「この端末に無い」と「取消」を区別できないので、
メニューは押した後にだけ出す (自動起動の取消では出さない。#3070 と同じ)。

```
この端末には Cernere のパスキーが見つかりませんでした
 ① ほかの端末のパスキーで入る      … ブラウザの「スマートフォンまたは別のデバイスを使用」(QR) で今回だけ入る
 ② この端末をアカウントに引き継ぐ  … 既に使っている端末と QR でつなぎ、この端末用のアカウントを作って連携する
 ③ はじめて使う                    … /start (名前 →「はじめる」)。独立した新しいアカウント
```

### 4.1 ② 引き継ぎ (新しい端末 B ← 使っている端末 A)

PC とスマホのどちらが A でも B でもよい。カメラがある側で読み、無い側で QR を出す。

1. B で「この端末を引き継ぐ」→ サーバが **引き継ぎ要求** を作る (`federation.join-request`、未ログインで可、IP レート制限)。
   要求 id・短命トークン (10 分、Redis に digest のみ、1 回)・4 桁の確認コードを返す。
2. B は QR (`https://<cernere>/federate/approve?t=<token>`) と 4 桁を表示する。B がスマホなら「カメラで読む」ボタンも出し、
   A 側 (PC) に QR を出してもらう逆向きも選べる (A の設定 →「端末を引き継ぐ」で同じ要求を A から作る)。
3. A (ログイン済み) が QR を読む (スマホはカメラ / PC は URL を開く) → `/federate/approve` で B の端末情報と 4 桁を照合させ、
   A のパスキーで承認 (action proof `federation.approve`)。
4. 承認されると B は通知を受け (WS / ポーリング)、**B の端末でパスキーを作成** (signup) → 新しいアカウントができ、
   同じトランザクションで A の連携に加わる (A が連携していなければ A を founder として連携を作る。subject = A の user id)。
5. B は名前を聞かない (主のプロフィールを使う)。オンボーディングはリカバリー QR・通知だけ。
6. 連携の全アカウントのセッションと通知先へ「新しい端末が連携した」を送る (security_events)。

### 4.2 あとから連携 (既存アカウント同士)

設定「アカウントの連携」から、既存アカウント C を連携に加えられる。4.1 と同じ QR・4 桁・両側のパスキー承認
(C 側でもパスキーで本人確認)。C が既にサービスを使っていた場合、**C の番号で保存されたサービスデータは連携番号へ移らない**
(自動で混ぜない)。承認前に「C で使っていたサービス: ○○、○○。連携後は連携の番号で扱われ、C のデータは見えなくなります」と表示する。

### 4.3 主の切り替えと離脱

- 設定で主を選ぶ (`federation.set_primary`、現在の主のパスキーで承認、expected revision)。subject は変わらない。
- アカウントを連携から外す (`federation.remove`、主の承認 / 本人の離脱)。外れたアカウントの subject は自分の user id に戻る
  (連携番号のデータは連携に残る)。最後の 1 つになったら連携を閉じる。subject を持つ founder が外れても subject は変えない。

## 5. 画面

- `frontend/src/pages/continue/ContinueMenuPage.tsx` — 引き継ぎメニュー (①②③)
- `frontend/src/pages/federate/JoinRequestPage.tsx` — B: QR・4 桁・カメラで読む・承認待ち → パスキー作成
- `frontend/src/pages/federate/ApprovePage.tsx` — A: 要求の確認・4 桁の照合・パスキー承認
- `frontend/src/pages/settings/FederationPage.tsx` — 連携の一覧・主の選択・追加 (QR を出す / 読む)・外す
- QR の読み取りは既存の `jsqr` (recovery-qr-image) を使う。カメラは `getUserMedia` (facingMode environment)、拒否時は
  画像ファイルの読み取りにフォールバック

## 6. 既存機能との関係

- 2026-10-16 neco の追加依頼: PC 用パスキー登録を連携設定より先に案内する。ログイン画面と引き継ぎメニューの推奨導線は、既存アカウントへ端末内パスキーを追加する。外部認証器で PC に入った場合も案内し、共用端末では飛ばせる。詳細は [SPEC-PC-PASSKEY-ENROLLMENT](../feature/pc-passkey-enrollment.md)。連携は登録後の任意設定とし、既存の QR 連携も残す。

- 既存の「別端末の追加」(同じアカウントにパスキーを足す device-link / pairing) は残す。引き継ぎメニューの ② は新しい連携を使う。
  設定画面では両方を並べ、違い (同じアカウントに足す / 端末ごとのアカウントを束ねる) を書く。
- 権限確認・サインアップ入力・許可制は subject と主で判定する (3)。

## 7. テスト

- subject: 未連携は自分の id / 連携は founder の id / 主を替えても不変 / 外れたら自分の id
- 各サービスの口 (3 の表) が subject を返すこと
- 引き継ぎ: トークン 1 回限り・期限切れ・4 桁不一致・承認者のパスキー必須・上限 10・既に連携済みのアカウントは不可
- 4.2 の警告にサービス利用履歴が出ること
- 主の切替の expected revision 競合

## 8. 実装メモ (2026-10-16)

- Actio: `actio:dedf7dcb-a31a-4a40-adca-bf56caffe63d`
- migration: `073_account_federation.sql` (072 は feat/service-signup-fields が使用)
- コード: `server/src/federation/` (policy = 純粋な判定 / subject = 番号の解決 / store = 連携の書き込み /
  join-request = 引き継ぎ要求 / service-usage = §4.2 の警告)、HTTP は `POST /api/federation/:action`
  (`server/src/http/federation-handler.ts`)。新しい端末のアカウント作成は `POST /api/auth/passkey/signup-finish` に
  `federation: { requestId, deviceSecret }` を付け、同じトランザクションで連携に加える。
- 契約: C-31〜C-35 (`server/src/federation/contracts/`)。

実装で決めたこと (設計書に無かった細部):

| 項目 | 決定 | 理由 |
|---|---|---|
| QR の token | `https://<cernere>/federate/approve#t=<token>` (fragment)。招待 (A → B) は `/federate/join#t=` | 既存の端末追加 (device-pairing) と同じく、履歴・Referer・プロキシログに残さない |
| 引き継ぎ要求の向き | device 起点 (B が QR と 4 桁) と approver 起点 (A が招待 QR、B が読むと 4 桁が B に出る) の 2 つ | §4.1-2 の「逆向き」。4 桁は常に加わる側にだけ出し、承認者が入力する |
| 4 桁 | 3 回間違えたら要求を失効 | device-pairing と同じ |
| 外れた founder | 連携が残っている間はサービスへ入れない (`federation_founder_detached`) | founder の user id = 連携番号なので、自分の id へ戻すと連携のデータが見えてしまう。連携を閉じれば自分の番号として戻る |
| 外れた founder の再加入 | 他の連携には入れない (`joiner_owns_subject`) | 番号の解決を冪等に保つ (subject → subject) |
| 主が外れたとき | 残りのうち最も古いアカウントが主 | 主の承認者が不在にならないように |
| Cernere 内の許可状態 | 連携していれば主の access_status (自分が locked なら locked) | 引き継ぎで作った端末のアカウントは pending で作られるが、同じ利用者として扱う |
| kiosk の限定交換口 (`/api/auth/code/exchange`) | 連携番号ではなくアカウントの id を返す | 顔の同意は accessToken のアカウントで記録されるため。authCode には内部用の `accountId` を持たせ、公開の交換口では外す |
| service token | 対象外 | 利用者を持たない (service → service)。relay の宛先は連携番号でもアカウントの id でも受け、連携の全アカウントへ配る |
| アカウント削除 | 削除前に連携から外す (本人の離脱と同じ) | `primary_user_id` の FK で削除が止まらないように |

## 9. PR 説明 (feat/account-federation)

### サービス境界の口と番号の扱い (grep で洗い出した全件)

| 口 | 場所 | 扱い |
|---|---|---|
| service 向け authCode | `server/src/auth/auth-code.ts` issueAuthCode | `user.id` = 連携番号、名前・email・role = 主。許可は `requireServiceAccess` (主の access_status)。内部用に `accountId` を持つ |
| authCode を出す全経路 | passkey composite / composite-session-code / project open_url / edge assertion / consent ticket / ws composite-auth | すべて issueAuthCode を通るので上記に従う。passkey composite の事前判定も `requireServiceAccess` |
| 公開の交換口 | `server/src/http/auth-handler.ts` exchange | 連携番号の `user` を返し、`accountId` を外す |
| kiosk の限定交換口 | `server/src/http/auth-code-exchange-handler.ts` | アカウントの id (顔の同意がアカウント単位のため。§8) |
| トークン検証 | `/api/auth/verify` (packages/id-cache が使う) | 連携番号と主の名前 |
| user×project token (PASETO) | `/api/auth/project-token` | `sub` / `userId` = 連携番号、role・displayName = 主 |
| OIDC | `server/src/oidc/provider.ts` | id_token / userinfo の `sub` (と `cr_access_email`) = 連携番号、claims = 主。access token のセッション束縛はアカウントのまま |
| OIDC の同意 | getConsentInfo / approveAuthorization / withoutDeniedScopes | 連携番号 |
| project user data の行 | `ensureUserProjectRow` (全呼び出し元) | 関数の中で連携番号に解決 (冪等) |
| 自分のサービスデータ・module opt-out | `commands.ts` managed_project my_data / my_data_all / overview / *_optout | 連携番号 |
| 同意記録 | consent gate / ticket-flow (describe・decide) / consent WS コマンド | 連携番号 (ticket はログインしたアカウントのまま) |
| サインアップ入力 (072) | consent gate / ticket-flow / signup_fields WS コマンド | 連携番号 |
| profile.get / profile.update | `server/src/project/profile-service.ts` | 受けた番号 → 主のアカウントを読み書き。拒否 (consent) は番号、core の opt-out は主 |
| identity claim | `get_identity_claims` / `resolve_user_by_claim` / `list_user_data` | 値は主から読む。逆引きの結果は連携番号 |
| relay | `server/src/ws/session-registry.ts` / `ws/handler.ts` | 宛先 user は連携番号でもアカウントの id でも受け、連携の全アカウントのセッションへ配る |
| managed_relay.request_peer | project-dispatch | サービスが渡す番号のまま (module opt-out が番号で持たれるので一致) |
| service token | `/api/auth/service-token` | 対象外 (利用者を持たない) |

Cernere 内部 (パスキー・セッション・端末管理・ログイン通知・セキュリティの出来事) はアカウントの user id のまま。

### 再利用探索の採否

| 候補 | 採否 | 理由 |
|---|---|---|
| device-pairing (`auth/device-pairing.ts`) の QR・4 桁・3 回失効 | 方式を採用 (コードは別) | 照合の流れと失効の規則をそろえた。pairing は同じアカウントへ候補パスキーを足す DB 行で、連携の要求 (未ログインで作れ、10 分・Redis digest のみ) とは保存先と寿命が違うため共有しない |
| action proof (`auth/action-proof.ts`) | 採用 | 承認・加入・主の切替・外すに新しい action を 4 つ足した |
| passkey signup (`finalizePasskeySignup`) | 採用 | `withinTx` で連携への加入を同じトランザクションに入れた |
| `recordSecurityEvent` | 採用 | federation.joined / left / primary_changed を追加し、連携の全アカウントへ通知 |
| `jsqr` / `decodeQrFromFile` (recovery-qr-image) | 採用 | カメラの映像の読み取りに jsQR、拒否時の画像読み取りに既存関数 |
| `createQrDetector` (BarcodeDetector) | 不採用 | 対応ブラウザが限られる。タスクの指定どおり jsqr に統一 |
| `PairingPanel` | 採用 | 設定「アカウントの連携」に並べて違いを書いた (§6) |

### 検証

- 実行: server `tsc --noEmit`、server `vitest run` 全件 (134 files / 1084 tests、DB は全てモック)、frontend `tsc --noEmit`
- 新規テスト: `server/tests/federation/` (policy / join-request / relay-group / service-boundary)、`server/tests/frontend/federation-links.test.ts`、`tests/consent/auth-code-gate.test.ts` に番号の検証を追加
- 既存テストは `tests/federation/unfederated-subject.ts` (未連携の番号解決) を差し込んで意味を保った
- Augur 契約 C-31〜C-35: 全て met (違反 0)
- 未実施: DB を要する統合テスト・起動確認 (指示により実行しない)。migration 073 の適用確認も未実施
- frontend `tsc` の `jsqr` 未解決 (2 件。うち 1 件は既存の recovery-qr-image): 本体 `E:/Document/Ars/Cernere/frontend/node_modules` に jsqr が無い (npm ci 未実施)。package.json には既にある

### 前提未確定 (人間の判断を待つもの)

- 外れた founder の扱い: 設計書は「founder が外れても subject は変えない」「外れたら自分の id に戻る」が両立しないため、連携が残る間はサービスへ入れない形にした (§8)
- founder のアカウントを削除すると、`user_service_consents` 等の `user_id` FK (ON DELETE CASCADE) により連携番号の同意記録が消える。連携番号を users から切り離すかは別途判断
- QR の token は `?t=` ではなく fragment (`#t=`) にした (§8)
