# @ludiars/cernere-service-adapter

LUDIARS 各サービスが Cernere と連携するための共通 SDK。次の 2 つのサブシステムを同一パッケージで提供する:

1. **User admission** (`CernereServiceAdapter`) — Cernere が承認したユーザが各サービスにアクセスするときの入口処理 + サービス固有 token の発行。
2. **Peer adapter** (`PeerAdapter`) — LUDIARS バックエンドサービス同士が **HTTP を使わず** に直接 WS で相互呼び出しできる仕組み。Cernere は認証局 + 仲介に徹し、データ経路には介在しない。

---

## インストール

```bash
npm install @ludiars/cernere-service-adapter
```

LUDIARS は private registry なので、`.npmrc` に次を設定する想定:

```
@ludiars:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

---

## User admission API (既存)

Cernere がユーザ admission を push したとき、サービス側がそれを受けて自前 DB への upsert + サービス token 発行を行うフロー。

```typescript
import { CernereServiceAdapter, createServiceAuthMiddleware } from "@ludiars/cernere-service-adapter";

const adapter = new CernereServiceAdapter({
  cernereWsUrl:  "ws://cernere:8080/ws/service",
  serviceCode:   "actio",
  serviceSecret: process.env.CERNERE_SERVICE_SECRET!,
  jwtSecret:     process.env.SERVICE_JWT_SECRET!,
}, {
  onUserAdmission: async (user) => { await userRepo.upsertFromCernere(user); },
  onUserRevoke:    async (userId) => { await sessionStore.revokeByUserId(userId); },
});
adapter.connect();

app.use("/api/*", createServiceAuthMiddleware({
  adapter,
  jwtSecret: process.env.SERVICE_JWT_SECRET!,
}));
```

---

## Peer adapter API (0.2.0 新規)

LUDIARS サービス間の backend-to-backend 通信。使う側は `invoke` / `handle` の 2 メソッドだけ意識すればよい。

### 起動

```typescript
import { PeerAdapter } from "@ludiars/cernere-service-adapter";

const sa = new PeerAdapter({
  projectId:       env.CERNERE_PROJECT_ID,       // managed_projects.client_id
  projectSecret:   env.CERNERE_PROJECT_SECRET,
  cernereBaseUrl:  env.CERNERE_URL,              // e.g. "http://cernere:8080"
  saListenHost:    "0.0.0.0",
  saListenPort:    0,                             // 0 = 動的ポート
  saPublicBaseUrl: "ws://actio.internal:{port}", // Cernere に通知する URL
  accept: {
    imperativus: ["tasks.create", "tasks.query"],
    nuntius:     "*",
  },
});

// 受信用 handler
sa.handle("tasks.create", async (caller, payload) => {
  // caller.projectKey / caller.clientId が検証済で渡ってくる
  return { id: "task-xyz" };
});

await sa.start();
```

### 発信

```typescript
const result = await sa.invoke<{ id: string }>(
  "actio",          // target projectKey
  "tasks.create",
  { title: "牛乳" },
);
```

### 停止

```typescript
await sa.stop();
```

---

## Peer adapter — 接続確立 protocol (7 ステップ)

Cernere 側を噛ませた challenge 方式で、各 peer 接続がなりすまし不能・リプレイ不能になるよう設計。

```
(1) admin が Cernere で relay_pairs に双方向ペアを登録
(2) 両サービスが project credentials で Cernere WS セッション確立
(3) managed_project.get_jwks で公開鍵を cache (ローカル検証用)
(4) SA WS を動的ポートで listen し、managed_relay.register_endpoint で URL 通知
(5) A が invoke → Cernere に request_peer → pair 確認 + 60s challenge 発行 + B URL 返却
(6) A → B へ WS 接続 (Authorization: Bearer <projJwt> + X-Relay-Challenge)
(7) B 側 adapter が
    - JWT を JWKS でローカル検証 → A の projectKey 取得
    - managed_relay.verify_challenge で challenge を Cernere 照会 →
      issuer が A projectKey と一致、target が自身であることを確認
    成立したら channel 確立. 以降 Cernere 介在なし.
```

### 設計上のメリット

| 観点 | PeerAdapter | HTTP + Bearer |
|---|---|---|
| Cernere on data path | **なし** | 毎 req verify round-trip (または JWKS 必要) |
| 毎 invoke あたり Cernere call | 0 | 0 (JWKS 使用時) |
| 接続確立 latency | 1 challenge round-trip (初回のみ) | 1 HTTP req (毎回) |
| リプレイ攻撃 | challenge が single-use + 60s TTL で防御 | token 盗難リスク |
| 切断検知 | WS 常時接続 | 毎 req 再確立 |
| 双方向 push | 可 (同一 channel で invoke 両方向) | 不可 |

### 障害耐性

| 障害 | 挙動 |
|---|---|
| Cernere 停止 | 既存 channel は継続動作. 新規 peer 接続のみ不可 |
| 相手サービス停止 | その peer のみ invoke fail. 他 peer は無影響 |
| ネットワーク分断 | 該当 peer 間のみ channel 切断 |
| Adapter 起動直後 | login → JWKS → register_endpoint の 3 段が成立するまで invoke は拒否 |

---

## Accept list

`accept` 設定は受信 invoke に対する fail-closed allow list。

```typescript
accept: {
  imperativus: ["tasks.create"],       // 指定コマンドのみ許可
  nuntius:     "*",                     // 全コマンド許可
  // unregistered peer は reject (forbidden)
}
```

これに加え Cernere 側の `relay_pairs` テーブルでも制御できるため、**2 段構え** で peer アクセスを絞る設計。

---

## テスト用ヘルパ — `FakeCernere`

他 LUDIARS サービスが PeerAdapter を取り込むときに、本物の Cernere を立てずに integration test を書けるよう、subpath export で公開している:

```typescript
import { FakeCernere } from "@ludiars/cernere-service-adapter/testing";
import { PeerAdapter } from "@ludiars/cernere-service-adapter";

test("my service responds to peer ping", async () => {
  const cernere = new FakeCernere({
    projects: [
      { projectKey: "actio",       clientId: "actio-cid", clientSecret: "actio-sec" },
      { projectKey: "imperativus", clientId: "imp-cid",   clientSecret: "imp-sec" },
    ],
    relayPairs: [["actio", "imperativus"]],
  });
  const { baseUrl } = await cernere.start();

  const actio = new PeerAdapter({ projectId: "actio-cid", projectSecret: "actio-sec",
    cernereBaseUrl: baseUrl, saPublicBaseUrl: "ws://127.0.0.1:{port}",
    accept: { imperativus: ["ping"] } });
  actio.handle("ping", async () => ({ pong: true }));
  await actio.start();

  // ... (別 adapter から invoke を試す)

  await actio.stop();
  await cernere.stop();
});
```

`FakeCernere` は RS256 project token の発行・JWKS 応答・relay_pair / challenge の管理を in-memory で再現する. 本物 Cernere 依存なし、ネットワーク分離で完結.

## バージョン履歴

- **0.2.0** — `PeerAdapter` (peer backend-to-backend) 追加 + `/testing` subpath export で `FakeCernere` 公開. 既存 `CernereServiceAdapter` は互換維持.
- 0.1.0 — `CernereServiceAdapter` (user admission).
