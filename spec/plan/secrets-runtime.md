# シークレットのランタイム取得（env 廃止 / env-cli の lib+daemon 化）

> サービス起動時に Infisical からシークレットを取得し、`.env` を一切使わない。
> bootstrap（Infisical 認証情報）は **ローカル secret-agent デーモン 1 箇所**に集約し、
> OS キーチェーンで保護する。AIFormat `RULE.md` §7（設定はファイル管理 / シークレットは
> 平文保存しない）の具体実装。

## 1. 背景 / 現状の課題

現行 `@cernere/env-cli`（各 repo に**ベンダリングコピー**）:
- Infisical(Universal Auth) → **temp `.env` を生成 → docker compose → `.env` 削除** という流れ。
- bootstrap（`siteUrl/projectId/environment/clientId/clientSecret`）を `.env.secrets` に
  **平文保存**（§7.2 違反）。
- 各 repo にコピーが散在し drift する。

課題: (a) 平文 `.env` / `.env.secrets` の存在、(b) bootstrap secret が各サービスに分散、
(c) 起動毎に手動 env を立てる運用。

## 2. 決定事項（2026-06-02）

| 項目 | 決定 |
|---|---|
| 形態 | **C ハイブリッド** — ライブラリ `@cernere/env` を窓口に、secret は `secret-agent` デーモンへ委譲（デーモン未起動なら lib が起動を保証） |
| bootstrap 保存 | **デーモンのみ保持** + **OS キーチェーン**（DPAPI / Keychain / libsecret）。平文ファイルにしない |
| Docker/コンテナ | **今回スコープ外**（ローカル Node サービスの in-process 取得に集中。コンテナは後続設計） |
| `.env` | **完全廃止**（temp 含む）。秘密はプロセスメモリのみ |

## 3. アーキテクチャ

```
service 起動
  └─ @cernere/env  loadConfig()
       1. 非シークレット設定を committed な secret.config.ts から読む (§7.1)
       2. secret-agent (loopback) に必要キーだけ要求
            ├─ agent 起動済 → secrets 返却（least-privilege）
            └─ agent 未起動 → lib が agent を ensure(spawn) → 初回は対話 setup
       3. 取得結果を process.env / typed config に in-process 注入（.env は書かない）
```

### 3.1 `@cernere/secret-agent`（ローカル常駐デーモン）
- **bootstrap**: `siteUrl/projectId/environment/clientId/clientSecret` を **OS キーチェーン**に保存。
  起動時にキーチェーンを確認し、無ければ**対話 setup**（現 `env-cli setup` のプロンプトを移植）
  → キーチェーンへ保存。平文ファイルは作らない。
- **Infisical 取得**: 既存 `infisical.ts`（UA → accessToken、`/api/v3/secrets/raw`）を再利用。
  accessToken は exp までメモリキャッシュ。
- **キャッシュ**: in-memory（(project,env,path) キー, TTL）+ 任意の**暗号化ディスクキャッシュ**
  （AEAD、鍵は OS キーチェーン、TTL、gitignore）でオフライン起動・再起動高速化。
- **API**: loopback のみ（Concordia 17330 と同方針）。
  `GET /v1/secrets?service=<name>` → そのサービスが宣言したキー集合のみ返す（least-privilege）。
  ローカル境界 + 任意の per-service token ファイル。
- **多プロジェクト**: agent が持つ UA identity が読める範囲を、各 service の config の
  projectId/environment/secretPath で引いて返す。
- CLI も残す（`secret-agent setup / list / set / test`）。secret 管理用途。

### 3.2 `@cernere/env`（ライブラリ＝サービスが import）
```ts
import { loadConfig } from "@cernere/env";
const cfg = await loadConfig();      // settings(非secret) + secrets を解決
cfg.settings.PORT; cfg.secrets.DATABASE_URL;
cfg.intoProcessEnv();                // 旧コード互換 (process.env 注入, in-memory only)
```
- `secret.config.ts`（**committed・非シークレット**）: `{ service, infisical:{projectId,environment,secretPath}, secretKeys:[...], settings:{...} }`。
  projectId/environment は識別子なのでコミット可（§7.1）。
- agent への接続を抽象化。agent 未起動なら ensure(spawn)。bootstrap は持たない。

## 4. 移行（段階）

- **P1**: `@cernere/secret-agent`（keychain bootstrap + 対話 setup + Infisical fetch + cache + loopback API）と `@cernere/env`（ensure-agent + fetch + inject）を**正式パッケージ化**（ベンダリングコピー廃止、git/npm dep 一本化）。
- **P2**: パイロット 1 サービス（Tr or Cernere）を `.env`/temp-.env から lib boot へ移行。既存 `.env.secrets` をキーチェーンへ取り込み、平文ファイルを削除。
- **P3**: 残サービスへ展開。各 repo の vendored env-cli と `env:up` の temp-.env フローを撤去（CLI のシークレット管理サブコマンドは残す）。
- **後続（別設計）**: Docker/コンテナ向け供給（agent から注入 or secrets mount）。

## 5. セキュリティ（§7 整合）

- bootstrap clientSecret は **OS キーチェーンのみ**（§7.2）。
- 平文 `.env` / `.env.secrets` を**どこにも作らない**（§7.1/7.2）。
- ディスクキャッシュは AEAD 暗号化（鍵はキーチェーン）+ TTL + gitignore。
- agent は loopback 限定。secrets 応答は service 宣言キーに限定（least-privilege）。

## 6. リスク / 要検討（実装フェーズ）

- **キーチェーン依存ライブラリ**: Win=DPAPI、mac=Keychain、Linux=libsecret。`keytar` か
  `@napi-rs/keyring` か DPAPI 直叩きかは実装時に評価（保守性・ネイティブ依存）。
- **起動順 / ヘッドレス**: 初回 setup は TTY 必要。CI / 無人環境向けに非対話 bootstrap 注入
  （一度きり env or ファイル → 即キーチェーン移送）経路を用意。
- **agent ライフサイクル**: 誰が起動・監視するか（lib ensure-spawn / OS サービス / Legatus 同梱）。
- **複数サービス同時起動**時の agent 単一化（ロック / 既存検出）。
