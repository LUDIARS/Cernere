# REVIEW_MISSING_FEATURES — 2026-05-13

評価: **B**

`/auth` + `/api/auth/project-token` の最小コアは揃っている。 ただし運用上欲しい以下の機能が未実装、 または明確に未着手。

## 機能ギャップ

### F-1. token 即時失効 (revoke) API

現状、 user accessToken / project accessToken / user_for_project token のいずれも **TTL 切れまで失効できない**。 漏洩時の手段としては refresh token を `refreshSessions` から削除する `logout` (`auth-handler.ts:194-201`) しかなく、 60 分間 accessToken は通る。 SECURITY.md にも記載なし。

対策案: token の `jti` を Redis に保存しブラックリスト判定、 もしくは `users.tokenVersion` カラムを増設し JWT に埋め込む。

### F-2. JWKS / 公開鍵公開エンドポイントが現状無い

`server/src/auth/jwt.ts:80-86` のコメントで JWKS 設計に言及はあるが (`managed_project.verify_token` WS コマンドへ委譲)、 HTTP の JWKS endpoint がない。 service-adapter (`packages/service-adapter/src/peer/peer-adapter.ts:20-33`) は **逆方向の検証** (peer 側が Cernere に verify_token を round-trip) で運用しているが、 一般的な OIDC consumer に提供しづらい。

将来 OAuth/OIDC 互換 IdP として開く想定があれば JWKS + `well-known/openid-configuration` を追加する。

### F-3. trusted device の自己管理 UI (revoke / 名称付与)

`migrations/013_trusted_devices.sql` で永続化されており `identity-verification.ts` の `checkDevice` で利用されるが、 **ユーザーが自分の信頼済みデバイス一覧を見て revoke する** 経路が WS コマンドにも frontend にも見当たらない (frontend を確認した範囲で該当 page なし)。 セキュリティ要件としては実装必須レベル。

### F-4. MFA backup codes / SMS opt-out

`migrations/003_mfa.sql` で `mfaMethods` が JSON で保持されるが、 backup codes 生成 / 表示の経路がコードに見当たらない。 MFA 強制したサービスで MFA デバイス紛失時の救済策が無い恐れ。

### F-5. project-token に `kid` / `aud` claim が無い

`generateUserProjectToken` (`server/src/auth/jwt.ts:96-106`) の claim は `{ sub, projectKey, role, kind }`。 `aud` (audience) を `projectKey` に固定し、 service 側で audience 検証を必須化すると **誤ったサービスへの token 提示** を拒否できる。 現状は `kind === "user_for_project"` の文字列で型を弁別している。

### F-6. 監査ログの保持・rotation ポリシー

`operation_logs` に全 WS コマンドが書き込まれるが、 retention / index rotation 戦略が migration からは読めない。 アクセス頻度の高いサービスでは長期間で table 巨大化する。 既存の migration コメント (CLAUDE.md §2 の `IF NOT EXISTS` 冪等性方針) と整合的な「論理削除 / archive table へ移動」運用を仕様化したい。

### F-7. `/api/auth/project-token` の telemetry

新規追加されたばかりで、 ヒット率や user/project 別の発行回数を観測するメトリクスが無い。 secret per-user / memory-only の原則を運用で守れているかは、 発行量ベースで監視すべき。

## 含意

機能不足のうち F-1 (revoke) と F-3 (trusted device revoke UI) は **セキュリティ機能の最低限** に分類されるため、 中期 roadmap に明記すべき。 F-5 (audience claim) は per-user token を service 間で誤用させないために短期で入れたい。 評価 **B**。
