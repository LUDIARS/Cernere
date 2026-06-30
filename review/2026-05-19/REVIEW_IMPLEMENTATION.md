# 実装評価 — Cernere (2026-05-19)

## 1. コード品質 — A

### TypeScript 厳密
- paseto.ts / identity-verification.ts ともに strict mode
- KeyObject 型で raw Buffer を reject
- Any 型なし (Record<string, unknown> は意図的)

### 関数分割 (paseto.ts)
- `loadKeys()` — env → keyset 構築
- `seedToPrivateKey()` — 32 byte seed → KeyObject (PKCS8 prefix)
- `parsePreviousKey()` — "kid:base64" parse
- `signProjectToken()` / `verifyProjectTokenPaseto()`

各関数 < 50 行、責任分離明確。

### Error handling 3 層
1. Explicit throw at startup (`config.ts` production guard)
2. Console warning for degraded mode (`paseto.ts` HS256 fallback warn)
3. Explicit error throw for runtime invalid (`Unauthorized: No token provided`)

## 2. データスキーマ — A

PASETO claims が ISO 8601 移行 (#95):
| claim | 値 |
|------|-----|
| sub | userId (UUID) |
| projectKey | managed_projects.key |
| role | users.role |
| aud | hub_url (audience binding) |
| iat | ISO 8601 |
| exp | ISO 8601 |
| jti | uuid (replay 検出) |

DB schema 変更なし (今期コミット範囲)。trusted_devices.geoInfo は互換性のため残置、常に `{}` 埋め。

## 3. SRE — A

- pino structured logging (全モジュール)
- log level env 可
- `[paseto]` `[identity]` 等の prefix で grep 可
- key rotation ceremony がドキュメント化済

## 4. パフォーマンス — A

| 変更 | 影響 |
|------|------|
| PASETO Ed25519 署名 | +5-10ms per token (短命 15 分で許容) |
| Device hash SHA-256 | +2-3ms (login 1 回のみ) |
| Vite proxy | dev のみのネットワーク経路 |
| HMR websocket | 初回接続のみ +100-200ms |

総合的にパフォーマンス劣化なし。

## 5. クロスプラットフォーム — A

- Vite dev server / Cloudflare Tunnel 経路 OK (`VITE_PUBLIC_HOST` opt-in)
- Windows/macOS/Linux で server 起動
- /.well-known/cernere-public-key endpoint は HTTP GET のため OS 非依存
