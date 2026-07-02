# 実装指示書: Cernere 認証強化の残タスク (2026-07)

> **委託実行者向け (GPT-5.5 等)**: モデル差異を出さないため、実装可能な残タスクは
> リテラルな before/after で固定する。**判断で埋める余地を残さない**。数値・文言・
> ファイル名・順序は指示書の通りに合わせること。独自の改善・リファクタは禁止。
> 「設計判断が要る」と明記したタスク (§B) は **この指示書の対象外**。着手しない。

- 前提: PR #136 (認証強度 7 項目) が **既に main へマージ済み**。本指示書はその続き。
- 対象リポ: `Cernere`
- 参照: マージ済みの `login-ip:` レート制限 (`server/src/http/auth-handler.ts`) と同ポリシーを踏襲。

---

## 0. 大原則

1. セキュリティ用レート制限は **Redis のまま** (`checkRateLimit`)。オンメモリ化しない。
2. main 直 push 禁止。ブランチ → PR。1 タスク = 1 PR。
3. §A のみ実装する。§B (設計判断待ち) は触らない。

---

## A. 実装タスク: ゲスト WS ログインへの per-IP レート制限

### 背景

PR #136 で REST の `login()` / `compositeLogin()` には per-IP 制限 (`login-ip:` 50/900s) を
入れたが、**WS 経由のゲストログイン (`ws/guest.ts` の `guestLogin`) は接続 IP を持たない**
ため入れられなかった。ここに同ポリシーの per-IP 制限を通す。

方針: WS upgrade 時 (`app.ts` の `/auth`) に既に算出済みの `ip` を `WsUserData` に載せ、
メッセージ処理 (`handler.ts`) からゲスト auth コマンド (`guest.ts`) へ引き回す。

### 作業ブランチ

```bash
cd Cernere
git checkout main && git pull --ff-only
git checkout -b feat/guest-ws-login-ip-throttle
```

### A-1. `WsUserData` に ip フィールド追加

**ファイル**: `server/src/app.ts`

BEFORE:
```ts
export interface WsUserData {
  userId: string;
  sessionId: string;
  isGuest: boolean;
  promoted: boolean;
  /**
   * close 後に send() するレースを防ぐフラグ。close ハンドラで即 true にする。
   * uWS は閉じた WebSocket を触ると例外を投げるため、async の await 挟み後の
   * send は必ず closed チェックが必要。
   */
  closed: boolean;
}
```
AFTER:
```ts
export interface WsUserData {
  userId: string;
  sessionId: string;
  isGuest: boolean;
  promoted: boolean;
  /** upgrade 時の接続元 IP (ゲストログインの per-IP レート制限に使う。監査用途)。 */
  ip?: string;
  /**
   * close 後に send() するレースを防ぐフラグ。close ハンドラで即 true にする。
   * uWS は閉じた WebSocket を触ると例外を投げるため、async の await 挟み後の
   * send は必ず closed チェックが必要。
   */
  closed: boolean;
}
```

### A-2. `/auth` upgrade で ip を userData に載せる

**ファイル**: `server/src/app.ts` — `/auth` の upgrade ハンドラ内。
`ip` は同ハンドラ冒頭で `const ip = getRemoteIp(res);` として既に算出済み。それを両分岐に足す。

BEFORE:
```ts
      const userData: WsUserData = auth
        ? { userId: auth.userId, sessionId: auth.sessionId, isGuest: false, promoted: false, closed: false }
        : { userId: "", sessionId: `guest_${crypto.randomUUID()}`, isGuest: true, promoted: false, closed: false };
```
AFTER:
```ts
      const userData: WsUserData = auth
        ? { userId: auth.userId, sessionId: auth.sessionId, isGuest: false, promoted: false, closed: false, ip }
        : { userId: "", sessionId: `guest_${crypto.randomUUID()}`, isGuest: true, promoted: false, closed: false, ip };
```

### A-3. メッセージ処理から ip を渡す

**ファイル**: `server/src/ws/handler.ts` — ゲスト auth コマンド呼び出し部 (現状 122 行目付近)。

BEFORE:
```ts
        const result = await handleGuestAuthCommand(msg.action, msg.payload);
```
AFTER:
```ts
        const result = await handleGuestAuthCommand(msg.action, msg.payload, data.ip);
```

> `data` は同関数冒頭の `const data = ws.getUserData();` (= `WsUserData`)。追加の取得不要。

### A-4. `guest.ts` に ip 引数と per-IP 制限を追加

**ファイル**: `server/src/ws/guest.ts`

**変更 1** — `handleGuestAuthCommand` のシグネチャに `ip` を追加し、各ハンドラへ渡す。

BEFORE:
```ts
export async function handleGuestAuthCommand(
  action: string,
  payload: unknown,
): Promise<GuestAuthResult> {
  const p = payload as Record<string, unknown> | undefined;
  if (!p) throw AppError.badRequest("Payload required");

  switch (action) {
    case "register": return guestRegister(p);
    case "login": return guestLogin(p);
    default:
      throw AppError.badRequest(`Guest auth action '${action}' not supported. Use 'register' or 'login'.`);
  }
}
```
AFTER:
```ts
export async function handleGuestAuthCommand(
  action: string,
  payload: unknown,
  ip?: string,
): Promise<GuestAuthResult> {
  const p = payload as Record<string, unknown> | undefined;
  if (!p) throw AppError.badRequest("Payload required");

  switch (action) {
    case "register": return guestRegister(p);
    case "login": return guestLogin(p, ip);
    default:
      throw AppError.badRequest(`Guest auth action '${action}' not supported. Use 'register' or 'login'.`);
  }
}
```

**変更 2** — `guestLogin` に `ip` 引数と per-IP 制限を追加。

BEFORE:
```ts
async function guestLogin(p: Record<string, unknown>): Promise<GuestAuthResult> {
  const email = p.email as string | undefined;
  const password = p.password as string | undefined;

  if (!email || !password) throw AppError.badRequest("email and password are required");

  await checkRateLimit(`ws_login:${email}`, 10, 900);
```
AFTER:
```ts
async function guestLogin(p: Record<string, unknown>, ip?: string): Promise<GuestAuthResult> {
  const email = p.email as string | undefined;
  const password = p.password as string | undefined;

  if (!email || !password) throw AppError.badRequest("email and password are required");

  // per-email: 標的アカウントへの総当たりを絞る。
  await checkRateLimit(`ws_login:${email}`, 10, 900);
  // per-IP: 1 IP から多数アカウントへ撒く credential stuffing を絞る (REST login と同ポリシー)。
  await checkRateLimit(`ws_login-ip:${ip ?? "unknown"}`, 50, 900);
```

> `guestRegister` は今回 **変更しない** (REST register も per-IP を入れていない。スコープ外)。
> `checkRateLimit` は `../redis.js` から既に import 済み。追加 import 不要。

### A-5. 検証ゲート

```bash
cd Cernere/server
npx tsc --noEmit          # → exit 0 (エラーなし)
npx vitest run            # → 全 pass (件数は main と同じ。新規テスト追加不要)
```

`ws/guest.ts` に対する既存テストがある場合、`handleGuestAuthCommand` の呼び出しが
2 引数のままでも `ip` は optional なので型エラーにはならない。落ちたら呼び出し側の
引数追加漏れを疑う。

### A-6. コミットメッセージ

```
feat(auth): ゲスト WS ログインに per-IP レート制限を追加

PR #136 で REST login に入れた per-IP 制限 (login-ip: 50/900s) を、
IP を持たなかった WS ゲストログイン経路にも適用する。upgrade 時の IP を
WsUserData に載せ、handler → guest.ts へ引き回して ws_login-ip: で絞る。
```

PR を作成し CI グリーンを確認して squash merge + ブランチ削除 + main 同期。

### A-7. 等価出力の最終確認

- [ ] `WsUserData` に `ip?: string` が追加されている。
- [ ] `/auth` upgrade の userData 両分岐に `ip` が入っている (他の WS 種別は変更しない)。
- [ ] `handler.ts` のゲスト auth 呼び出しが `handleGuestAuthCommand(msg.action, msg.payload, data.ip)`。
- [ ] `guestLogin` に `ws_login-ip:` **50・900** の制限が入り、キー・数値が REST と一致。
- [ ] `guestRegister` は未変更。
- [ ] `git diff --stat main` = 3 ファイル (`app.ts` / `ws/handler.ts` / `ws/guest.ts`)。
- [ ] `tsc --noEmit` exit 0、`vitest run` 全 pass。

---

## B. 設計判断が要る残タスク (この指示書の対象外・着手しない)

以下は「コードを書くだけ」では済まず、先に方式決定が要る。**GPT-5.5 は着手せず**、
Fable/ユーザの設計確定を待つ。参考として現状の論点と推奨だけ記す。

### B-1. 初回登録 admin ブートストラップの締め (元 項目4)

- 現状: `register`/`compositeRegister`/`guestRegister` は users が 0 件のとき先着 1 名を
  `admin` にする (TOFU)。公開登録が開いていると誰でも admin を取れる。
- 論点: fresh install で admin をどう作るか vs 誰でも admin を防ぐか、のトレードオフ。
- 推奨案 (要承認): env `CERNERE_ADMIN_BOOTSTRAP_TOKEN` を設け、一致した登録のみ
  admin 昇格。未設定時は全員 general (= admin は手動プロビジョン)。3 経路で共通化。
- **決定待ち**: token 方式で良いか / デフォルト挙動をどうするか。

### B-2. RateLimiter / SessionStore の抽象化 (元 項目7)

- 目的: 「1 インスタンス = オンメモリ主体、N インスタンス = Redis」を config で切替。
- これはインターフェース設計 + 2 実装 + 差し替え点の洗い出しを伴う設計タスク。
  byte 等価の機械的 spec には落とせない。別途 Fable が設計 doc を書いてから委託する。
- 注意: **セキュリティ用レート制限は in-memory 化しない** (per-instance で実効上限が緩む)。

### B-3. サービス間 mTLS (元 gRPC/入口強化の議論)

- サービス間 (Cernere ↔ Hub/各 service) の入口を mTLS + トークン束縛で固める案。
- インフラ (証明書配布・ローテーション) を伴う大タスク。設計 doc を分けて起こす。
