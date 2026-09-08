# MFA の保存契約

機能正本: `spec/feature/mfa-authenticator.md`。ユーザーデータの正本は Cr。

| 保存先 | 内容 | 機微性・保護 | 寿命 |
|---|---|---|---|
| users.totp_secret | Authenticator の共有鍵。AES-256-GCM の既存 secret-box 形式 | credential。本人認証処理だけが復号し、一般プロフィールへ返さない | 解除・アカウント削除まで |
| users.totp_enabled | 登録コードの照合済み状態 | 非公開の認証設定 | 同上 |
| users.totp_last_step | 最後に使用した TOTP 時間カウンタ (bigint / nullable) | 認証内部のリプレイ防止。user row lock 下で比較更新 | 同じ鍵の解除まで。再起動で初期化しない |
| users.mfa_revision | 設定変更の通し番号 (integer / default 0) | 認証内部。古い設定への復元でも番号を戻さない | アカウント削除まで |
| users.mfa_methods / mfa_enabled | 利用可能な追加要素と必須化フラグ | 認証設定 API のみ更新。本人確認と既存要素または passkey が必要 | 設定変更まで |
| Redis mfa-ticket:SHA256(ticket) | user ID、用途、設定状態ハッシュ、session/project 束縛、期限 | 認証内部。通常セッションと別 namespace。元の32 byte ticket は保存しない | 5分または原子的な消費まで |
| Redis mfa-mail:digest | challenge に束縛したコードの HMAC-SHA256 | OTP 平文は保存しない。宛先は users.email からのみ取得 | ticket の残り期限、再送または消費まで |
| Redis mfa-setup:digest | 本登録前の暗号化 TOTP 鍵 | ticket と同じ本人・session に限定。本人画面だけで QR 化 | ticket の残り期限または消費まで |
| Redis mfa-limit:* | 発行・試行・送信の回数 | 認証内部。ユーザー単位と ticket 単位を併用 | 60秒 / 5分 / 15分 |

MFA 設定はパスワード・プロフィールの公開項目ではなく、サービス別 profile grant の対象にも含めない。
QR・手動入力キー・コード・management token はブラウザの component state にだけ持ち、
localStorage / URL / ダウンロード資料 / ログへ書き出さない。
TOTP 登録情報は5分経過時に画面から除去する。React unmount で timer を解除する。
ユーザー行と refresh_sessions の SQL parameter は開発ログでも伏せる。

migration: `migrations/047_mfa_authenticator.sql`。本作業では稼働 DB へ適用していない。
更新は既存ユーザー行を対象とし、期限・回数制限を無効にする fallback や平文鍵への移行は行わない。
