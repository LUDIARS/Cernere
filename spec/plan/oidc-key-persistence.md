# OIDC signing-key persistence

署名鍵を DB に永続化し、「OIDC を使わない」構成を明示できるようにする作業。
機能仕様は [`spec/feature/oidc-provider.md` §1.1](../feature/oidc-provider.md)、
運用手順は [`spec/setup/oidc-provider.md`](../setup/oidc-provider.md)。

- [x] Add the `oidc_signing_keys` migration and Drizzle schema.
- [x] Resolve signing keys in env → DB current key → generated-and-persisted order.
- [x] Initialize OIDC keys after migrations and before the server listens.
- [x] Cover repository injection, concurrent initialization, retired-key JWKS filtering, and pre-init behavior with unit tests.
- [x] Encrypt `private_key_pem` at rest via `encryptSecret()` (RULE.md §7.2).
- [ ] DB 鍵のローテーション経路 (`is_current=false` + `retired_at` を書く admin 操作)。
      現状 `findRetiredSince()` を満たす行は生成されないため、 ローテーションは
      env (`CERNERE_OIDC_PRIVATE_KEY` + `_PREVIOUS_PUBLIC_KEYS`) 経由でのみ可能。
