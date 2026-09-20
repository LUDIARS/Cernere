# 企業認証のデータスキーマ

正本は Cr。管理 UI や SDK は以下の保存契約に従い、外部アプリへユーザー正本を複製しない。

| 保存先 | 分類・内容 | 保護と更新元 | 寿命 |
|---|---|---|---|
| enterprise_connections | マスター: project / 組織 / OIDC client / team / AUD / MFA 条件 / 期間 / active / revision / updated_at | システム管理者の接続中 WS + action proof。secret を含まない。revision 楽観ロック | 接続を無効化して保持。参照先 project / 組織 / client 削除時 cascade |
| enterprise_identities | ユーザーデータ: project、subject_hash、Cr user ID、active、revision | Cr 管理者が組織メンバーへ明示対応付け。project 自身は自分の対応を失効できる。subject は SHA-256。メール照合をしない | user / 接続削除時 cascade。team / 組織変更で対応解除。再対応は新 revision |
| refresh_sessions.authentication | ユーザーデータ: 実際の authTime / authTimeMs、amr、MFA revision | 認証完了時だけ生成。通常の refresh と code は値を保存継承。SQL parameter をログで伏せる | 既存 refresh session と同じ期限。旧行 null は証拠なし |
| JWT authentication | 認証情報: 上記検証済み事実 | Cr 署名。client 入力で上書きしない。通常 access token の寿命 | 既存 access token の期限 |
| Redis authsession / authcode の authentication | 一時ユーザーデータ: 同一認証の引き継ぎ | 既存の session / code の本人・用途束縛と TTL | 既存短命 session / 一回限り code の期限 |
| Redis oidc:req:* | 認可要求: createdAtMs / forceReauth / maxAge を追加 | 検証済み client / redirect、ランダム ID、GETDEL | 600秒または同意の消費まで |
| Redis oidc:code:* / oidc:at:* | 認可 grant: 承認セッション (sub / role / authEpoch / mfaRevision / deviceId / authentication) と、project / 組織 / connection revision / role / joinedAt / 絶対期限 | code は一回限り。認証事実は承認セッション側にだけ持ち二重化しない。交換と userinfo でセッション失効と企業認可の両方を照合 | code120秒、ATは既存上限と企業絶対期限の最短 |
| Redis enterprise-session:SHA256(token) | ユーザーデータ: user / project / 組織 / subject hash / 各 revision / role / joinedAt / authTime / amr / expiresAt | opaque token の原文は保存しない。client ごとに現在の組織権限を照合 | Access exp・認証期間・session 上限の最短。refresh で延長しない |
| Cloudflare custom claims | Cr の OIDC 認証事実の外部提供 | 管理者登録済み専用 client / callback にのみ提供。公開 role は組織 role。本文に secret / OTP はない | Cr OIDC / Access token の期限 |

enterprise_connections.project_key は managed_projects.key の FK、oidc_client_id は unique FK。
enterprise_identities は (project_key, subject_hash) PK と (project_key, user_id) unique。
組織メンバーは認証・対応更新のたびに確認する。退会を DB FK だけに任せない。

migration `048_enterprise_cloudflare.sql` は追加のみ、IF NOT EXISTS で再実行可能。
稼働 DB への適用は本実装セッションでは行わない。

ログは assertion / Cloudflare subject / token を秘匿し、新規テーブルの SQL parameter を伏せる。
管理画面の一覧に subject_hash・生 subject・secret を返さない。入力 subject は component state のみ。
取得した authentication を使って新しいプロフィール公開範囲や Cr システム role を設定しない。
