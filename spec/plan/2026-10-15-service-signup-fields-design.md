# サービス経由ログイン時の「そのサービスで使うデータ」入力 設計

- 日付: 2026-10-15
- 依頼: neco「サービスから呼ばれた Cr だった場合 (GLab に Cr でログインするケース) は、名前の後にそのサービスで
  使うデータを入力させる。Cr のアカウントが既にある場合は GLab で使う分だけ入力する。」
- 前提: [権限確認 (consent) の設計](2026-10-15-service-consent-design.md) (main・AWS 反映済み)、
  「はじめる」でアカウント作成 (#3074、審査中: /start で名前 →「はじめる」でパスキー作成とアカウント作成 → /onboarding)

## 1. 目的

サービス (managed project) がログインに必要とする利用者ごとのデータ (例: GLAB の所属・学籍番号) を、
そのサービスへの初回ログインの流れの中で Cernere が聞き、`project_data_<storage_slug>` に保存する。

- 新規 (サービス経由で Cernere を始めた人): 名前 → 「はじめる」(アカウント作成) → **そのサービスの入力** →
  リカバリー QR・スマホ・通知 → サービスへ戻る
- 既存 (Cernere のアカウントはある人): そのサービスへの初回ログイン時に、**そのサービスの入力だけ** を求める。
  他のサービスの項目は聞かない。入力済みの項目は聞き直さない
- 必須項目が未入力のままではサービスへの authCode を出さない (権限確認の必須と同じ扱い)

## 2. 宣言 (サービス側)

`schema_definition.signup_fields` を追加する。project client が `update_schema` で宣言してよい
(consent と同じ。管理者所有ではない)。保存時に検証する。

```yaml
signup_fields:
  version: 1                 # 増やしたら未入力の新項目だけ聞き直す
  fields:
    - column: affiliation    # user_data.columns に存在し _deleted でない列だけ
      label: "所属"
      required: true
      input: text            # text | textarea | select | boolean | number
      max_length: 100        # text / textarea
      placeholder: "例: ゲーム制作学科"
      help: "メンバー一覧で所属ごとに分けるため"
    - column: grade
      label: "学年"
      required: false
      input: select
      options: [{ value: "1", label: "1 年" }, { value: "2", label: "2 年" }]
```

検証:
- `column` は `user_data.columns` に存在し `_deleted` でない。列の型と `input` が合う
  (text/textarea/select → text、boolean → boolean、number → integer / bigint)。合わなければ保存拒否
- 項目は 20 件まで。`label` 必須 (1..40 文字)。`select` は options 1..50 件
- 入力項目は consent の `user_data.module:<module>` と矛盾してはならない: その列の module が consent 宣言にある場合、
  `level` が recommended の module の列を `required: true` にはできない (推奨を外した人に入力を強制しない)

## 3. 判定 (Cernere 側)

`server/src/consent/` の関門 (`gate.ts`) を、権限確認と入力の両方を見る判定に広げる。
入力の判定は新しい純粋関数に分ける (SRP):

- `server/src/signup-fields/declaration.ts` — 宣言の Zod スキーマと列との突き合わせ
- `server/src/signup-fields/requirement.ts` — `(宣言, 現在の行の値, 同意で拒否された module) → { missingRequired[], optionalUnfilled[], fields }`
  拒否された module の列は「聞かない」(必須でも聞かない。2 の検証で必須にはならない)
- `server/src/signup-fields/store.ts` — 本人の行 (`project_data_<slug>`) の読み書き (`ensureUserProjectRow` を使う)

関門の規則:
- `signup_fields` を宣言したサービスだけが対象 (宣言 = 有効化。consent_mode とは独立)。
- 必須が未入力なら、consent_mode に関係なく authCode を出さず `ConsentRequiredError` (同じ consentTicket・
  同じ `/consent` 画面) を投げる。応答のコードは `consent_required` のまま (サービス側の対応を増やさない)。
- 任意項目だけが未入力のときは止めない (画面には次回以降出さない。プロフィールの「サービスの権限」から入れられる)。
- 一度画面を出して任意を空のまま進んだ人に、同じ版で再表示しない (`signup_fields.version` を同意記録と同じ表に
  `fields_version` として保存)。版が上がったら未入力の新項目だけ出す。

## 4. 画面

### 4.1 `/consent` (既存の権限確認画面) に入力欄を足す

- 上から「必須の権限」「推奨の権限」「<サービス名> で使う情報」の順。入力欄は `signup_fields` の順に並べ、
  必須に印を付ける。各欄に「誰が読めるか」(consent の visible_to をその列の module から引く。無ければ「このサービス」)。
- 「同意して続ける」で、権限の決定と入力値を **1 回の WS 呼び出し** で送る (`consent.decide` に `fields` を追加)。
  サーバーは同じトランザクションで同意記録と行の更新を行う。入力の検証失敗は項目ごとのエラーを返し、何も保存しない。
- 既存アカウントの初回ログインもこの画面だけで済む (= GLab で使う分だけ入力)。

### 4.2 新規アカウント (サービス経由) の順番

`/start` → 「はじめる」→ アカウント作成 → `/onboarding` の **最初の手順** に「<サービス名> で使う情報」を出す。
オンボーディングは戻り先 (`return`) から対象サービスを解決する:

- 戻り先が `/composite/login?origin=...` / `redirect_uri=...` なら、その origin を
  `resolveSubjectByOrigin` と同じ規則でサービスに解決する WS コマンド `signup_fields.for_return` を足す
  (本人セッション、戻り先は Cernere 内パスのみ。サービスの公開情報 (名前・宣言) と本人の入力状況だけを返す)。
- 解決できたら、名前の次に入力欄 (4.1 と同じ部品) を出し、`signup_fields.save` で保存してからリカバリー QR へ進む。
- ここで必須を入れたので、戻った後の関門では入力の不足で止まらない (権限確認が必要なら /consent は出る)。
- 解決できない (Cernere 単独で始めた) ときは出さない。

部品: `frontend/src/components/signup-fields/SignupFieldsForm.tsx` (入力欄の描画と項目エラー表示) を 4.1 と 4.2 で共用。

## 5. データ

- migration: `user_service_consents` に `fields_version INTEGER` を追加 (NULL = まだ見せていない)。DROP なし。
  番号は着手時の main と未マージブランチを見て採番。
- 値は既存の `project_data_<storage_slug>` に書く。書けるのは宣言された列だけ (SQL 識別子は宣言と列定義の
  照合後に識別子として扱う。値はパラメータ)。

## 6. サービス側の対応 (GLAB など)

1. `signup_fields` を宣言する (どの列を聞くか)。列が無ければ `user_data.columns` に足す。
2. ログイン後に自前の「初回設定画面」で同じ項目を聞いていたなら、それを外す (二重入力を避ける)。
3. 展開タスク (`spec/tasks/2026-10-15-service-consent-rollout.md`) に GLAB の項目として追記する。

## 7. テスト

- 宣言: 存在しない列・型の不一致・推奨 module の列を必須にする宣言を拒否
- requirement: 未入力の必須だけ不足に数える / 入力済みは聞かない / 拒否 module の列は聞かない / 版上げで新項目だけ
- 関門: 宣言なしは素通り / 必須不足で consent_mode=off でも止まる / 任意だけ不足は通す
- decide: 権限と入力を同じトランザクションで保存、項目エラー時は何も保存しない
- for_return: Cernere 外の戻り先・未登録 origin は null

## 8. 実装メモ (2026-10-15、actio:8cb286a9-bfd6-4437-b13f-b013bbeb9035)

- 配置: `server/src/signup-fields/` — `declaration-schema.ts` (形) / `declaration.ts` (列・consent との突き合わせ、C-27) /
  `requirement.ts` (要否、C-28) / `values.ts` (入力値の検証、C-29) / `return-target.ts` (戻り先、C-30) /
  `evaluate.ts` (材料集め) / `store.ts` (行の読み書き) / `submission.ts` (受け付け) / `command.ts` (WS) / `errors.ts`。
  許可の保存手順は `consent/grant.ts` に集約 (/consent と「サービスの権限」で共用)。
- 「版が上がったら未入力の新項目だけ」を見分けるため、`fields_version` に加えて `fields_seen JSONB` (その版で見せた列) を
  同じ migration (072) で足した。どちらも DROP なし。
- 行の書き込みは `ensureUserProjectRow` と同じ `ON CONFLICT (user_id)` の upsert 1 文で行う (同意と同じトランザクションに載せるため)。
- 入力の誤りは ticket を使い切る前に返す (直して送り直せる)。REST は 422 `signup_fields_invalid` + `fieldErrors`、
  WS (`consent.decide` / `signup_fields.save`) は応答の `fieldErrors`。
- 保存済みの宣言を残す部分更新 (auto-sync) では宣言を再検証しない。消えた列は判定で聞かなくなる。
- 許可待ち (案 A) の新規アカウントでもオンボーディングで入力できるよう、`signup_fields.for_return` / `save` を
  許可待ちの本人操作に加えた (本人の行だけを読み書きする)。
- オンボーディングでの保存は同意の行がまだ無いので `fields_version` を残さない。必須は入っているので関門では止まらず、
  権限確認が要るときだけ /consent が出る。

