# Cernere フロントエンドの Corpus 宣言的 UI 移行 — UI 設計

> 2026-06-07 起草。 Cernere の自前 React SPA (frontend/) を Corpus の宣言的
> レンダリング (Corpus DESIGN.md §13) に載せ替えるための **UI 設計**。
> 本書は第一段階 = 画面の棚卸し + Corpus UI カード (descriptor) 定義 +
> 共通化方針までを確定する。 サーバ側 REST エンドポイント実装・corpus.ts
> 実装・SPA 撤去は後続 PR (§9 移行フェーズ)。

関連:
- Corpus 宣言的レンダリング正本: `Corpus/DESIGN.md` §13 (ComponentDescriptor 9 種) / §14
- pilot 実装の実例: `Aedilis/server/corpus.ts`
- マニフェスト型: `Corpus/server/hub/manifest.ts`
- 現行 Cernere フロント: `Cernere/frontend/src/pages/`

---

## 1. 目的とスコープ

### 1.1 目的

Cernere の全画面 (ログイン / ダッシュボード / データオプトアウト / 管理者) を
corpus-renderer が描く **descriptor (JSON)** で宣言し直し、 **Cernere 自前
frontend (React SPA) を完全撤廃**する。 ログインも未認証 render で descriptor 化
できる (§2 C-1) ため、 bespoke UI はゼロになり、 Cernere は backend のみ
(REST データ EP + descriptor EP + custom 部品) を配信するサーバになる。
「サービスは UI を書かない (descriptor だけ書く)」 という Corpus §13 の目標を
Cernere にも適用し、 同 descriptor を Web / デスクトップ / ゲームエンジンの
各ホストに流用する (§1.4)。

### 1.2 スコープ (本書)

- 現行 5 ページ (Login / Dashboard=Projects / Organizations / Profile /
  DataOptOut) と、 暗黙の「管理者操作」 を Corpus パネルへどう写すかの設計
- 各パネルの UI カード = PanelDescriptor / ComponentDescriptor 定義
- **データ以外で共通化できる UI 部品の括り出し** (§4)
- 宣言で書けない箇所 (escape hatch / descriptor 拡張要求) の洗い出し (§7)
- 移行に必要なサーバ側前提 (manifest `data[]` REST 化) の宣言 (§8)

### 1.3 スコープ外 (本書では決めない / 後続)

- corpus.ts (マニフェスト + descriptor) の実装
- WS ハンドラを叩く REST データエンドポイントの実装
- 既存 React SPA (`frontend/`) の実削除 (撤廃の実装は P6)
- §7 で「descriptor 拡張」 と判定した分の Corpus 本体への実装 (Corpus 側 PR)

### 1.4 設計原則 — descriptor はホスト非依存 (Web / デスクトップ / ゲームエンジン流用)

corpus-renderer は「descriptor + `data()` + identity」 のみを入力とし、 hub 本体・
認証・特定 DOM 実装に依存しない自己完結パッケージ (§13.7)。 したがって **同じ
descriptor を別ホストのレンダラ実装で描ける**:

- Web (Corpus shell) — DOM レンダラ
- デスクトップ (Tauri 等) — 同 descriptor を埋め込み
- **ゲームエンジン / ネイティブ描画** — Pictor / Ergo の native UI 層が
  descriptor を解釈すれば、 ゲーム内 UI として Cernere ログイン/アカウント等を
  そのまま再利用できる

これは「UI を JSON で宣言し、 描画は host 側レンダラ実装が担う」 という宣言的
レンダリングの本質的な利点。 本書で定義する Cernere の descriptor は **特定の
描画ホストを前提にしない** ように書く (DOM 固有の指定を descriptor に持ち込ま
ない)。 host 固有事情 (WebAuthn / postMessage 等) は `custom` 部品に閉じ込め、
custom は host ごとに別実装を差せる差し替え点とする (§7)。 これにより
Cernere の認証 UI が Web hub にもネイティブ/ゲームクライアントにも 1 つの
descriptor で行き渡る。

> 含意: §7 で `custom` に落とす部品 (passkey / MFA / member 検索 等) は
> 「host 非依存にできない箇所」 の一覧でもある。 host ごとの実装差は custom の
> tag 実装側に閉じ、 descriptor 本体は共有され続ける。

### 1.5 設計原則 — descriptor/リソースはローカルキャッシュ (描画はネットワーク非依存)

宣言的レンダリングは **「UI 定義 (descriptor + 描画リソース) = 静的でキャッシュ
可能」 と「データ = 動的で都度取得」 を分離**する。 これにより描画そのものに
ランタイムのネットワークコストを払わなくて済む:

- **ネイティブ host (デスクトップ / ゲームエンジン)** — descriptor と UI
  リソース (アイコン / フォント / custom 部品 / レイアウト定義) を **ローカルに
  同梱 / 永続保持**できる。 起動後の描画はネットワーク 0。 走るのはデータ取得
  (§8 の `data()`) だけ
- **Web host** — UI 描画リソースを **事前取得して WebStorage 系 (localStorage /
  IndexedDB / Cache Storage) に置き**、 2 回目以降はそこから描く。 descriptor は
  バージョン付きで配信し、 変化が無ければ再取得しない (ETag / version キー)

つまりランタイムで回線に乗るのは原則 **データ (§5 `data[]`) のみ**。 UI の
骨格は一度取れば使い回す。 §13.5 の「descriptor は静的 / data は manifest 経由」
という分離がそのままキャッシュ境界になる。

> 実装メモ (後続): descriptor EP (`/api/corpus/ui/*`) は version/ETag を返し、
> custom 部品バンドル (`public/corpus-ui/*.js`) は immutable な content-hash
> ファイル名で配信する。 詳細キャッシュ戦略は host (Corpus shell) 側の責務で、
> 本書は「descriptor/リソースはキャッシュ可能に設計する」 ことだけ定める。

---

## 2. Cernere 固有の制約 (他サービス移行との差分)

Cernere は Corpus に集約される **leaf サービスではなく、 Corpus 自身が認証
する先 (authority)**。 この非対称性から、 他サービス (Aedilis / Bibliotheca /
Actio) の declarative 化には無い 3 つの制約がある。

### C-1. ログインは pre-auth で描く。 レンダラ (≠ hub サービス) なので描画可能

**Corpus はサービスではなく汎用レンダラ** (`@ludiars/corpus-renderer`、 §13.7)。
入力は「descriptor + `data(dataId, init)` + identity」 のみで、 hub 本体にも
認証にも依存しない。 したがって `identity = null` (未認証) でも descriptor を
描け、 **ログイン画面も descriptor として描画できる** (当初「鶏卵で不可」 と
した判断は誤り)。

これにより **Cernere frontend (自前 React SPA) は全撤廃**する。 ログイン含む
全画面が descriptor 化され、 描画は **host 側レンダラ** (Web は Corpus shell、
他はデスクトップ/ゲームエンジン、 §1.4) が担う。 Cernere は backend のみ —
REST データ EP + descriptor EP (`/api/corpus/ui/*`) + custom 部品バンドル
(`public/corpus-ui/*.js`) を配信する純粋なサーバになる。 host は未認証時に
ログイン descriptor、 認証成立後にパネル descriptor を render する。

ただしログイン UI 内の一部インタラクションは宣言で書けず `custom` になる:
- WebAuthn / パスキー (`@simplewebauthn/browser` の `startAuthentication`) — §7-G2
- デバイスフィンガープリント収集 + MFA チャレンジ WS フロー — §7-G11
- composite ログイン (popup/iframe + postMessage で auth_code 返却) — §7-G12

宣言で書ける部分:
- email/password の `form` (submit 先は REST `/api/auth/login` `/register`)
- Google / GitHub OAuth ボタン (遷移は action-button のナビゲート、 §7-G3)

レンダラ側に 1 つ要求が要る: **未認証 render + auth-submit で identity を確立**
するモード (フォーム成功時に返るトークンを host が保持して再 render)。 §7-G13。
詳細な descriptor は §6.0。

> **composite ログインは撤廃する** (移行しない)。 host (Corpus / Excubitor) が
> Cernere の **常時接続セッション = アクセストークンを握る** ため、 他サービスを
> 開くときに per-service の再ログインが要らない (ambient SSO、 C-4)。 popup/
> iframe + postMessage で auth_code を渡す composite ハンドシェイクは存在理由が
> 消える。 これで frontend 撤廃の残課題はゼロになる。

### C-2. データ経路が WebSocket。 declarative レンダラは REST

現行 Dashboard / Organizations は WS の `wsClient.sendCommand(module, action,
payload)` で全操作する (Cernere の常時接続セッション基盤、 CLAUDE.md §1)。
一方 Corpus レンダラは manifest `data[]` の `id` を介して **`data(dataId,
init)` = REST fetch** でしか叩かない (§13.5)。

→ **方針: declarative パネルが使う読み書きは REST データエンドポイントを新設**
し、 内部で既存 WS モジュールハンドラ (managed_project / organization /
member / user / profile / optout) を呼ぶ薄いアダプタにする。 これは Cernere
サーバ側の前提作業 (§8)。 WS 経路は **リアルタイム (presence) と既存連携の
ために残す** が、 frontend / composite が消えるので UI からの利用は無くなる。

### C-3. 認証は「自分のトークン」。 project-token 中継は無い

leaf サービスは Corpus から `cernere-project-token` を受け取って検証する。
Cernere パネルのデータは **ログイン中ユーザ自身のアカウント操作** であり、
Corpus が D5 で保持する **user accessToken** (Cernere が native 検証できる)
をそのまま使えばよい。 project-token の二段は不要。

→ manifest の `auth` は leaf の `cernere-project-token` ではなく、 Cernere
自己トークン直接検証 (本書では `cernere-user-token` と呼ぶ)。 Corpus は
`/api/hub/data/:service/...` 中継時に user accessToken を透過する
([[feedback_secret_per_user_memory_only]] と整合 — 共有 secret を作らない)。

### C-4. ambient SSO — host が active session を握り per-service ログインを消す

host (Corpus / Excubitor) は Cernere の **常時接続セッション** を握り、 その
**user accessToken** を保持し続ける ([[project_cernere]] の Always-Connected
Session + Corpus D5)。 1 度 host にログインすれば、 以後ユーザがどのサービスを
開いても **host が持つトークンを渡すだけ** で済み、 サービスごとの再ログイン
画面が要らない (ambient SSO)。

含意:
- **composite ログインの撤廃** — 他サービス埋め込みログイン (popup/iframe +
  postMessage で auth_code 交換) は、 host がトークンを既に握るので存在理由が
  消える。 §7-G12 は「移行」 ではなく「削除」 に分類が変わる
- ログイン descriptor (§6.0) は **host への初回ログイン 1 回だけ** 描かれる。
  Cernere パネル / 他サービスパネルは認証済 host から token を継承する
- トークンの保持は per-user / memory-only を維持
  ([[feedback_secret_per_user_memory_only]])。 host が落ちれば再ログイン

> これにより frontend 撤廃の最後の障害 (composite) が消える。 §10 の論点
> からも外れる (q4 解決)。

---

## 3. 画面の棚卸しと写像

ユーザ提示の 4 区分と、 現行ページ・移行後パネルの対応:

| ユーザ区分 | 現行ページ | 移行後 Corpus パネル | 移行可否 |
|---|---|---|---|
| ログインUI | `LoginPage` | `login` (未認証 render、 §6.0) | ✓ (WebAuthn/MFA は custom) |
| ログインUI | composite | **撤廃** (C-4 ambient SSO で per-service ログイン不要) | — |
| ダッシュボード | `DashboardPage` (Projects) | `projects` パネル | ✓ |
| ダッシュボード | `ProfilePage` | `account` パネル | ✓ (パスキーのみ custom) |
| ダッシュボード | `OrganizationsPage` | `organizations` パネル | ✓ (検索のみ拡張要) |
| データオプトアウト | `DataOptOutPage` | `data` パネル | ✓ (data 固有) |
| 管理者画面 | (各ページにインライン) | `requires:"admin"` ＋ 任意 `admin` 集約パネル | ✓ |

「管理者画面」 は現行では独立ページではなく、 各ページ内にインライン散在する
(プロジェクト登録 / スキーマ編集 / 無効化、 組織作成 / メンバー追加 / ロール
変更)。 Corpus では各コンポーネントの `requires:"admin"` でゲートする。 加えて
これら管理操作だけを 1 枚に集約した `admin` パネルを **任意で**提供する (§6.5)。

---

## 4. 共通化方針 (データ以外の UI を括り出す)

「データ以外 UI が同じようなパーツは共通化する」 への回答。 共通化は **2 層**
で達成する。

### 4.1 第 1 層 — Corpus 内蔵レンダラが既に共通プリミティブ

Corpus の 9 ComponentDescriptor (§13.4) が、 各画面で繰り返し現れる UI 構造
そのもの。 Cernere は **同じ component 型を、 異なる束縛 (dataSource/fields)
で宣言するだけ**。 つまり描画ロジックの共通化は Corpus レンダラ側で既に完了
しており、 Cernere は「同型カードの再宣言」 を避ける。

現行 React で各ページが手書きしていた以下は、 すべてレンダラ提供の共通部品に
吸収される:

| 現行の手書き UI (各ページに重複) | Corpus 共通プリミティブ |
|---|---|
| `bg-surface + border + radius + padding` のカード枠 | `section` コンテナ |
| ラベル + input の縦積みフォーム | `form` / `FormField` |
| カード grid 一覧 (Projects / OptOut categories) | `list` (item card) |
| key-value 詳細 (Project detail / Profile 基本情報) | `detail` |
| 行 + 列のメンバー表 | `table` |
| 緑/赤のメッセージバナー (成功/失敗) | action の `success` / レンダラ標準のエラー表示 |
| confirm ダイアログ | ActionDescriptor `confirm` |
| 件数バッジ | `stat` |
| 接続状況 / 名前 / Logout の上部バー + ナビ | **Corpus シェル** (パネルでは描かない) |

シェル (ヘッダ・ナビ・接続バッジ・ユーザ名・ログアウト) は現行
`AppLayout.tsx` が各認証ページを包んで描いていたが、 Corpus 移行後は **Corpus
シェルが一度だけ描く**。 Cernere パネルはコンテンツ部分のみを宣言する。 これが
最大の重複削減。

### 4.2 第 2 層 — corpus.ts 内の共有ビルダ (TS フラグメント)

descriptor は JSON だが、 Cernere の `server/corpus.ts` は TypeScript で組み立てる
(Aedilis pilot と同様)。 画面間で形が同じでデータだけ違うカードは、 **TS の
ヘルパ関数 / const** に括り出して spread 再利用する。 重複宣言を避けるための
Cernere 側の共通化レイヤ。 括り出す候補:

- `card(title, components)` — `{ type:'section', title, components }` の薄い包み
- `kvDetail(dataId, recordPath, rows)` — `detail` カードのビルダ
- `messageStatus` 系 — 成功/失敗文言は各 action の `success` に寄せる (バナーは
  レンダラ標準)
- `roleBadge(value)` — ロール表示の meta テンプレート (`{role}`) の共通文言
- `adminOnly(component)` — `{ ...component, requires:'admin' }` を付すユーティリティ
- **オプトアウトカードのビルダ** `optOutCard(serviceId, categoryKey, label,
  desc)` — `data` パネル専用 (§6.4)。 ここは「データ固有」 なので第 2 層に
  閉じ、 他パネルへは持ち出さない (ユーザ要件「データ以外を共通化」)。

> 注: 第 2 層は実装 (corpus.ts) の話。 本書では「ビルダで括る」 という規約を
> 決めるに留め、 実体は §9 移行フェーズで書く。 SRP / ファイル分割は
> `coding-conventions` に従い、 ビルダ群は `server/corpus/` 配下に分割する。

### 4.3 共通化しないもの (データ固有)

ユーザ方針どおり、 以下は各パネル/データに固有として括り出さない:
- 各 `form` の実フィールド集合 (Profile のパーソナリティ項目 / Org 作成項目 /
  Project スキーマ JSON)
- `dataSource` / `dataId` の id 群
- オプトアウトのカテゴリ定義とトグル意味論 (§6.4)

---

## 5. マニフェスト骨子 (`/.well-known/corpus-service.json`)

```jsonc
{
  "service": "cernere",
  "displayName": "Cernere",
  "version": "1.0.0",
  "corpusApi": 2,
  "health": "/api/health",
  "auth": "cernere-user-token",        // C-3: 自己トークン直接検証 (project-token 中継しない)
  "cernereProjectKey": "cernere",
  "data": [
    // ── auth (未認証で叩く。 §6.0 login descriptor 用) ─────
    { "id": "auth-login",    "path": "/api/auth/login",                "scope": "local", "title": "ログイン" },
    { "id": "auth-register", "path": "/api/auth/register",             "scope": "local", "title": "新規登録" },
    { "id": "auth-google",   "path": "/api/auth/google/url",           "scope": "local", "title": "Google OAuth URL" },
    { "id": "auth-github",   "path": "/api/auth/github/url",           "scope": "local", "title": "GitHub OAuth URL" },
    // ── account ───────────────────────────────────────────
    { "id": "me",            "path": "/api/corpus/me",                 "scope": "local", "title": "自分の基本情報" },
    { "id": "my-profile",    "path": "/api/corpus/profile",            "scope": "local", "title": "パーソナリティ" },
    // ── projects ──────────────────────────────────────────
    { "id": "projects",      "path": "/api/corpus/projects",           "scope": "local", "title": "プロジェクト一覧" },
    { "id": "project",       "path": "/api/corpus/projects/:key",      "scope": "local", "title": "プロジェクト詳細" },
    { "id": "project-open",  "path": "/api/corpus/projects/:key/open", "scope": "local", "title": "プロジェクトを開く URL" },
    { "id": "templates",     "path": "/api/corpus/templates",          "scope": "local", "title": "サービステンプレート" },
    // ── organizations ─────────────────────────────────────
    { "id": "orgs",          "path": "/api/corpus/orgs",               "scope": "local", "title": "所属組織" },
    { "id": "org-members",   "path": "/api/corpus/orgs/:id/members",   "scope": "local", "title": "組織メンバー" },
    { "id": "user-search",   "path": "/api/corpus/users/search?q=:q",  "scope": "local", "title": "ユーザ検索" },
    // ── data opt-out ──────────────────────────────────────
    { "id": "optouts",       "path": "/api/corpus/optouts",            "scope": "local", "title": "オプトアウト状況" },
    { "id": "my-data",       "path": "/api/corpus/my-data",            "scope": "local", "title": "プロジェクト別保持データ" }
  ],
  "panels": [
    { "id": "account",       "kind": "declarative", "title": "アカウント",   "icon": "👤", "uiEndpoint": "/api/corpus/ui/account" },
    { "id": "projects",      "kind": "declarative", "title": "プロジェクト", "icon": "📦", "uiEndpoint": "/api/corpus/ui/projects" },
    { "id": "organizations", "kind": "declarative", "title": "組織",         "icon": "🏢", "uiEndpoint": "/api/corpus/ui/organizations" },
    { "id": "data",          "kind": "declarative", "title": "データ管理",   "icon": "🔒", "ui": { /* §6.4 インライン可 */ } },
    { "id": "admin",         "kind": "declarative", "title": "管理",         "icon": "🛠", "uiEndpoint": "/api/corpus/ui/admin", "requires": "admin" }
  ]
}
```

`ui` インライン vs `uiEndpoint` の使い分け (§13.2): カテゴリやテンプレートが
動的に増減するパネル (account/projects/organizations/admin) は `uiEndpoint`、
カテゴリ定義が静的な `data` の枠組みはインライン (中身の一覧は `dataSource`
で動的取得) を基本とする。

> パネルレベルの `requires:"admin"` は §13 の component 共通フィールドを panel
> へ拡張する要求 (§7-G6)。 未対応の間は `admin` パネルを出さず、 各管理操作を
> 既存パネル内の `requires:"admin"` component として置く。

`login` (§6.0) は `panels[]` に **入れない**。 hub のタブではなく、 host
(Corpus shell 等) が未認証時に取得して描く pre-auth descriptor だから
(manifest panel = 認証後の hub タブ)。 ログイン descriptor は
`/api/corpus/ui/login` で配信し、 host が identity 無し時に取得する。

---

## 6. パネル別 UI カード定義

テンプレート記法・filter は Corpus §13.5 準拠 (`{field}` / `{field|datetime}`)。

### 6.0 `login` (未認証 render)

C-1 のとおり、 レンダラは `identity = null` でも描けるのでログインも descriptor
化する。 **host (Web は Corpus shell)** が未認証時に Cernere の **ログイン
descriptor** (`/api/corpus/ui/login`) を取得して描き、 `form` submit 成功で
identity を確立 → 認証後パネルへ再 render。 Cernere 側に frontend は無い。

```jsonc
{
  "descriptorVersion": 1,
  "title": "Cernere",
  "sections": [
    { "components": [
      // email/password — login / register をタブで切替 (tabs)
      { "type": "tabs", "tabs": [
        { "label": "ログイン", "components": [
          { "type": "form",
            "submit": { "dataId": "auth-login", "method": "POST",
                        "success": "ログインしました" },   // 成功で identity 確立 (§7-G13)
            "fields": [
              { "name": "email",    "label": "メール",       "input": "text",     "required": true },
              { "name": "password", "label": "パスワード",   "input": "password", "required": true } ] } ] },
        { "label": "新規登録", "components": [
          { "type": "form",
            "submit": { "dataId": "auth-register", "method": "POST", "success": "登録しました" },
            "fields": [
              { "name": "name",     "label": "名前",         "input": "text",     "required": true },
              { "name": "email",    "label": "メール",       "input": "text",     "required": true },
              { "name": "password", "label": "パスワード (8文字以上)", "input": "password", "required": true } ] } ] } ] },

      // OAuth — 外部 URL へナビゲート (§7-G3)
      { "type": "action-button", "label": "Google でログイン",
        "action": { "dataId": "auth-google", "method": "GET", "then": "navigate" } },
      { "type": "action-button", "label": "GitHub でログイン",
        "action": { "dataId": "auth-github", "method": "GET", "then": "navigate" } },

      // パスキー / MFA は browser API・多段フロー → custom (§7-G2/G11)
      { "type": "custom", "tag": "cernere-passkey-login", "url": "/corpus-ui/passkey-login.js" } ] }
  ]
}
```

宣言で書けるのは email/password form と OAuth ナビゲートまで。 `input:"password"`
は現行 9 種に無い (§7-G14 で追加要求、 暫定は `text`)。 パスキー認証 / MFA
チャレンジ / デバイスフィンガープリントは `custom` 部品で吸収する。

composite ログイン (他サービス埋め込み) は postMessage + フィンガープリント +
MFA が密結合のため当面スタンドアロン維持 (§7-G12)。

### 6.1 `account` パネル (= 現行 Profile)

```jsonc
{
  "descriptorVersion": 1,
  "title": "アカウント",
  "sections": [
    { "title": "基本情報",
      "components": [
        { "type": "detail", "dataSource": "me", "recordPath": "user",
          "fields": [
            { "label": "名前",         "value": "{name}" },
            { "label": "メール",       "value": "{email}" },
            { "label": "システムロール", "value": "{role}" } ] } ] },

    { "title": "パーソナリティデータ",
      "components": [
        { "type": "form",
          "submit": { "dataId": "my-profile", "method": "PATCH", "success": "保存しました" },
          "fields": [
            { "name": "roleTitle", "label": "役割",     "input": "text" },
            { "name": "bio",       "label": "自己紹介", "input": "textarea" },
            { "name": "expertise", "label": "得意分野 (カンマ区切り)", "input": "text" },
            { "name": "hobbies",   "label": "趣味 (カンマ区切り)",     "input": "text" },
            // プライバシー公開/非公開トグル — 現行は項目右の独立トグル。
            // 宣言では checkbox に落とす (§7-G5 で UX 差を許容)
            { "name": "privacy.roleTitle", "label": "役割を公開",     "input": "checkbox" },
            { "name": "privacy.bio",       "label": "自己紹介を公開", "input": "checkbox" },
            { "name": "privacy.expertise", "label": "得意分野を公開", "input": "checkbox" },
            { "name": "privacy.hobbies",   "label": "趣味を公開",     "input": "checkbox" } ] } ] },

    { "title": "パスキー (WebAuthn)",
      "components": [
        // WebAuthn の register は browser API 必須 → custom (§7-G2)
        { "type": "custom", "tag": "cernere-passkey-manager", "url": "/corpus-ui/passkey.js" } ] }
  ]
}
```

データ管理への導線は Corpus シェルの `data` タブが担うため、 現行 Profile
末尾の「データオプトアウト管理」 リンクカードは不要 (削除)。

### 6.2 `projects` パネル (= 現行 Dashboard)

一覧は利用者ビュー (接続状況 / データ有無バッジ + 「開く」)。 詳細はスキーマ
表。 admin だけ登録 / スキーマ編集 / 無効化が見える。

```jsonc
{
  "descriptorVersion": 1,
  "title": "プロジェクト",
  "sections": [
    { "components": [
      { "type": "list",
        "dataSource": "projects", "itemsPath": "items", "itemKey": "key",
        "empty": "利用可能なプロジェクトはありません",
        "item": {
          "title": "{name}",
          "subtitle": "{key}",
          "body": "{description|truncate:80}",
          // 接続/データ状況は meta テンプレートで (バッジ相当)。
          // booleanな色分けバッジは §7-G4 で要検討
          "meta": "{connectionLabel} · {dataLabel}",
          "actions": [
            { "label": "開く", "dataId": "project-open", "method": "GET",
              "params": { "key": "{key}" } },         // 返却 url を新タブで開く (§7-G3)
            // ↓ admin 限定操作
            { "label": "無効化", "dataId": "project", "method": "DELETE",
              "params": { "key": "{key}" },
              "confirm": "\"{key}\" を無効化しますか?", "requires": "admin" } ],
          "edit": {                                    // admin: スキーマ編集 (インライン)
            "dataId": "project", "method": "PATCH", "params": { "key": "{key}" },
            "success": "更新しました", "requires": "admin",
            "fields": [
              { "name": "schemaDefinition", "label": "スキーマ定義 (JSON)",
                "input": "textarea" } ] } } } ] },

    // admin: 新規登録フォーム (テンプレート選択 + JSON)
    { "title": "プロジェクト登録", "requires": "admin",
      "components": [
        { "type": "form",
          "submit": { "dataId": "projects", "method": "POST", "success": "登録しました" },
          "fields": [
            { "name": "template", "label": "サービステンプレート", "input": "select",
              "optionsSource": "templates", "optionsPath": "items",
              "optionLabel": "name", "optionValue": "key" },
            { "name": "definition", "label": "定義 (JSON)", "input": "textarea" } ] } ] }
  ]
}
```

> JSON を `textarea` に入れる方式は宣言で書けるが、 検証/ハイライトが無く現行
> より退行する (§7-G7)。 v1 は許容、 将来 `custom` の JSON エディタへ。
> 詳細スキーマ表 (現行 detail 内の column テーブル) は `detail` では表現でき
> ないため、 詳細表示は `list` item の展開 or 別 `table` パネルに送る (§7-G8)。

### 6.3 `organizations` パネル

```jsonc
{
  "descriptorVersion": 1,
  "title": "組織",
  "sections": [
    { "components": [
      // 組織選択 + メンバー表。 現行は org 選択で members を再取得する
      // master-detail。 宣言では「組織ごとの table」 を list で並べるか、
      // org 選択を form select にしてパラメタ付き data で members を引く
      { "type": "table",
        "dataSource": "org-members", "itemsPath": "items",
        "columns": [
          { "header": "メンバー", "value": "{displayName}" },
          { "header": "メール",   "value": "{email}" },
          { "header": "ロール",   "value": "{role}" },
          // presence (online/offline) は WS push。 宣言は polling 列に退行
          // (§7-G9)
          { "header": "状態",     "value": "{presenceLabel}" } ],
        "rowActions": [
          { "label": "削除", "dataId": "org-members", "method": "DELETE",
            "params": { "id": "{organizationId}", "userId": "{userId}" },
            "confirm": "このメンバーを削除しますか?", "requires": "admin" } ] } ] },

    // admin: 組織作成
    { "title": "組織作成", "requires": "admin",
      "components": [
        { "type": "form",
          "submit": { "dataId": "orgs", "method": "POST", "success": "作成しました" },
          "fields": [
            { "name": "name", "label": "名称", "input": "text", "required": true },
            { "name": "slug", "label": "Slug", "input": "text", "required": true },
            { "name": "description", "label": "説明", "input": "text" } ] } ] },

    // admin: メンバー追加 — ユーザ検索オートコンプリートは現状 9 component に
    // 無い。 §7-G1 で descriptor 拡張 (autocomplete) を要求。 暫定 custom も可
    { "title": "メンバー追加", "requires": "admin",
      "components": [
        { "type": "custom", "tag": "cernere-member-add", "url": "/corpus-ui/member-add.js" } ] }
  ]
}
```

> ロール変更 (行内 select で即時 update) は `rowActions` がボタン前提のため
> 現状表現できない (§7-G10)。 暫定は「ロール変更」 ボタン → 値選択 action、
> または member-add 同様 custom。

### 6.4 `data` パネル (= 現行 DataOptOut) — **データ固有**

ユーザ方針で「共通化しない」 データ固有領域。 コアプロファイルのカテゴリと
プロジェクト別モジュールのカテゴリを並べ、 各々オプトアウト/撤回トグル。

```jsonc
{
  "descriptorVersion": 1,
  "title": "データ管理・オプトアウト",
  "sections": [
    { "title": "Cernere コアプロファイル",
      "components": [
        { "type": "list",
          "dataSource": "optouts", "itemsPath": "core", "itemKey": "categoryKey",
          "empty": "カテゴリがありません",
          "item": {
            "title": "{label}",
            "body": "{description}",
            "meta": "対象: {fields}",
            "actions": [
              // オプトアウト状態の双状態スイッチ (§13.6 toggle)
              { "label": "データ提供",
                "kind": "toggle", "state": "{enabled}",
                "dataId": "optouts", "method": "POST",
                "params": { "serviceId": "{serviceId}", "categoryKey": "{categoryKey}" },
                "body": { "enabled": "{toggled}" },
                "confirm": "「{label}」 の提供を停止しますか? 既存データは削除されます" } ] } } ] },

    { "title": "プロジェクト",
      "components": [
        { "type": "list",
          "dataSource": "my-data", "itemsPath": "modules", "itemKey": "moduleKey",
          "empty": "登録済みプロジェクトはありません",
          "item": {
            "title": "{projectName} / {moduleName}",
            "body": "保持データ: {columns}",
            "meta": "現在の値: {currentValues|truncate:60}",
            "actions": [
              { "label": "データ提供",
                "kind": "toggle", "state": "{enabled}",
                "dataId": "optouts", "method": "POST",
                "params": { "serviceId": "{projectKey}", "categoryKey": "{moduleKey}" },
                "body": { "enabled": "{toggled}" },
                "confirm": "「{projectName} / {moduleName}」 の提供を停止しますか?" } ] } } ] }
  ]
}
```

トグルの意味: `enabled=true` (提供中) ⇄ `false` (オプトアウト)。 現行の
「オプトアウト/撤回」 2 ボタンを 1 トグルへ集約 (§13.6 の toggle が適合)。
サーバ側は `enabled:false` で create-optout + データ削除、 `true` で
remove-optout に振り分ける (§8)。

### 6.5 `admin` パネル (任意・集約)

§3 のとおり管理操作は各パネルに `requires:"admin"` で散在させるのが基本だが、
「管理者画面」 を 1 枚で見たい要件のため、 projects 登録フォーム +
organizations 作成/メンバー管理 + テンプレート一覧を集約した `admin` パネルを
任意で提供する。 中身は §6.2 / §6.3 の admin セクションを `tabs` で束ねた
再掲 (corpus.ts では §4.2 のビルダ再利用)。 パネル自体を `requires:"admin"`
でゲート (§7-G6 待ち)。

---

## 7. descriptor 表現力ギャップと拡張要求

移行で現行 9 component では書けない箇所。 「**E** = escape hatch (custom/script)
で回避」 / 「**X** = Corpus descriptor 拡張を要求 (汎用、 他サービスも益)」 に
分類。 拡張要求分は §13.4/§13.6 と同じ手順で `Corpus/DESIGN.md` + renderer +
vitest を別 PR で更新する (Corpus 側作業)。

| # | ギャップ | 区分 | 推奨対応 |
|---|---|---|---|
| G1 | ユーザ検索オートコンプリート (依存サジェスト) | **X** | form input `autocomplete` を新設 (`optionsSource` + クエリ param `q`)。 暫定 E (custom `cernere-member-add`) |
| G2 | パスキー登録/削除 (WebAuthn browser API) | **E** | custom `cernere-passkey-manager` (原理的に宣言不可) |
| G3 | action のレスポンス url を新タブで開く | **X** | ActionDescriptor に `then:"open-url"` 等の結果ハンドラ。 暫定 E |
| G4 | boolean で色が変わるステータスバッジ | **X** | item に `badges:[{label,value,tone}]` を追加。 暫定 meta テンプレートで文字表示 |
| G5 | 項目ごとの公開/非公開トグル (フォーム内インライン) | △ | checkbox で代替 (UX 差は許容) |
| G6 | panel レベルの `requires:"admin"` | **X** | ManifestPanel に `requires` 追加。 未対応間は component ゲートで代替 |
| G7 | JSON エディタ (検証/ハイライト) | △/E | v1 は textarea で許容、 将来 custom |
| G8 | 詳細内のスキーマ列テーブル (detail + table の混在) | △ | `section` で detail と table を併置 (既存で可) |
| G9 | リアルタイム presence (WS push の online ドット) | **E**/△ | polling データ列に退行 or custom。 リアルタイムは WS 維持 |
| G10 | 表の行内 select で即時更新 (ロール変更) | **X** | rowActions に `select` action 種を追加。 暫定 E |
| G11 | MFA チャレンジ + デバイスフィンガープリント (多段 WS フロー) | **E** | custom `cernere-passkey-login` 等に内包。 host 非依存にできず custom 確定 |
| G12 | composite ログイン (popup/iframe + postMessage) | **撤廃** | host が active session を握る (C-4 ambient SSO) ので不要。 移行せず削除 |
| G13 | 未認証 render + auth-submit で identity 確立 | **X** | レンダラに pre-auth モード (form 成功で返るトークンを host が保持 → 再 render) |
| G14 | `password` 入力種 (マスク) | **X** | FormField `input` に `password` 追加。 暫定 `text` |

§13 で既に解決済み (拡張不要) の Cernere ニーズ: 一覧カード (`list`) /
フォーム (`form`) / 詳細 (`detail`) / 表 (`table`) / インライン編集
(`list.item.edit`) / トグル (`kind:"toggle"`) / 静的 select (`options`) /
動的 select (`optionsSource`+`optionsPath`) / admin ゲート component
(`requires:"admin"`)。

---

## 8. サーバ側の前提 (本書スコープ外・後続実装)

declarative パネルが叩く §5 `data[]` の REST エンドポイントを Cernere に新設。
各々は既存 WS モジュールハンドラを呼ぶ薄いアダプタ (C-2)。 認証は user
accessToken (C-3)。

| dataId | method | 内部委譲 (既存 WS) |
|---|---|---|
| auth-login / auth-register | POST | 既存 REST `/api/auth/*` (新設不要) |
| auth-google / auth-github | GET | OAuth URL 返却 (既存) |
| me | GET | session user_state |
| my-profile | GET/PATCH | `profile` get/update |
| projects | GET/POST | `managed_project` list+overview / register |
| project | GET/PATCH/DELETE | `managed_project` get / update_schema / delete |
| project-open | GET | `managed_project` open_url |
| templates | GET | `managed_project` templates |
| orgs | GET/POST | `organization` list / create |
| org-members | GET/DELETE | `member` list / remove |
| user-search | GET | `user` search |
| optouts | GET/POST | `optout` list / create+remove (enabled で分岐) |
| my-data | GET | `managed_project` myDataAll |

§13.5 のとおり Corpus は manifest `data[]` に列挙された path しか叩けないので、
これがサービス契約の境界になる。 実装は migration フェーズ §9-P2。

---

## 9. 移行フェーズ

| Phase | 内容 | 本書 |
|---|---|---|
| P0 | 本 UI 設計 + UI カード定義 + 共通化方針 | ✅ 本書 |
| P1 | Corpus 側 descriptor 拡張 (§7 X 項のうち着手するもの: G1/G4/G6 優先) | Corpus PR |
| P2 | Cernere サーバ: §8 REST データエンドポイント + `/api/corpus/ui/*` + manifest | Cernere PR |
| P3 | custom 部品 (passkey / passkey-login / member-add) を `public/corpus-ui/` に配信 | Cernere PR |
| P4 | host の active session 保持 → ambient SSO 経路を確認 (C-4)、 composite 依存サービスを Cernere token 継承へ切替 | Cernere/結合 |
| P5 | Corpus shell に Cernere を接続 → ログイン+全パネル動作確認 → ギャップ再洗い出し | 結合 |
| P6 | **`frontend/` ディレクトリを完全削除** (React SPA + composite 撤廃) + Dockerfile/nginx/CI 整理 | Cernere PR |

各 PR は [[feedback_concurrent_session_branch]] に従い feat ブランチ + PR
([[feedback_auto_merge_flow]])。 prototyping-flow の SaaS 系 (Cernere+Corpus+
フロント刷新) に該当するため、 P2-P3 は同一 PR に寄せてよい。 P6 (frontend 撤廃)
は P5 結合確認グリーン + ambient SSO 切替完了 (P4) を満たしてから。

---

## 10. オープン論点

1. **管理者画面の形** — 各パネル `requires:"admin"` 散在 (基本) と集約 `admin`
   パネル (§6.5) のどちらを正にするか。 G6 (panel-level requires) の Corpus
   対応可否次第。
2. **presence のリアルタイム性** (G9) — オプトアウトされた退行 (polling 列)
   を許容するか、 presence ドットだけ custom で残すか。
3. **JSON スキーマ編集** (G7) — textarea 退行を v1 許容するか、 最初から
   custom エディタを用意するか。 [[feedback_decision_metrics]] で評価する。
4. **Cernere 直アクセス時のホスト** — frontend 撤廃後、 Cernere を直接ブラウザ
   で開いた場合に誰が renderer を提供するか。 Corpus shell へリダイレクトで
   一本化するか、 Cernere server が corpus-renderer を載せた最小ホスト HTML を
   1 枚だけ配信するか (bespoke SPA ではなく renderer の薄い土台)。
5. **ambient SSO の token 受け渡し境界** (C-4) — host が握る user accessToken を
   サービスパネルへ渡す具体方式 (Corpus 中継 `/api/hub/data` 透過 vs サービス
   が host から都度 project-token を引く)。 §14-論点 4 (Corpus DESIGN) と整合
   させる。 [[feedback_secret_per_user_memory_only]] を満たすこと。

> 解決済 (改訂で close): composite ログインの処遇 → C-4 で撤廃に確定。
