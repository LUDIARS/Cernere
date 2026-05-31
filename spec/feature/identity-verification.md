# 本人確認 (Identity Verification)

新しい / 普段と異なるデバイスからのサインインを検知し、メール送信した 6 桁コードで本人確認を行う仕組み。

## 設計方針

- **位置情報 (Geolocation API) は取得しない**。マシン情報 + ブラウザ情報 + 接続元 IP のみで識別する
- 信頼済みデバイスは `trusted_devices` 表で永続化し、次回以降は無確認で通過させる
- 未知のデバイスは Redis に 10 分 TTL の challenge を保存し、メール送信した 6 桁コードと照合

## フィンガープリント

```ts
interface DeviceFingerprint {
  machine?: {
    os: string; platform: string; arch?: string;
    screen: string; timezone: string; language: string;
  };
  browser?: {
    vendor: string; browser: string; version: string;
  };
  // geo は廃止 (旧バージョンとの互換のため型上は無視)
}
```

ハッシュ計算: 上記を正規化 (null フィールドも保持) → JSON シリアライズ (キーソート) → SHA-256 hex。
表示ラベル: `"macOS · Chrome 124"` 形式 (旧 `... · Tokyo, JP` の地名は廃止)。

## チェックフロー

```mermaid
flowchart TD
    Start([checkDevice]) --> HasFp{fingerprint<br/>あり?}
    HasFp -- No --> IssueMissing[issueChallenge<br/>anomalies=missing_fingerprint]
    HasFp -- Yes --> Hash[deviceHash 計算]
    Hash --> Lookup[(trusted_devices SELECT<br/>userId + hash + revokedAt IS NULL)]
    Lookup --> Found{既知?}
    Found -- Yes --> Touch[(lastSeenAt + lastIp UPDATE)]
    Touch --> Trusted([trusted=true])
    Found -- No --> Anom[detectAnomalies<br/>過去 20 件と比較]
    Anom --> Issue[issueChallenge<br/>anomalies=...]
    IssueMissing --> Mail
    Issue --> Mail[6 桁コード生成<br/>SET device_challenge:&lt;token&gt; TTL 10min]
    Mail --> Send[メール送信<br/>mailer.sendMail]
    Send --> Return([trusted=false<br/>deviceToken, anomalies, emailMasked])
```

### Anomaly 種別

| 値 | 意味 |
|---|---|
| `new_device` | このユーザの信頼済みデバイス全件と hash 不一致 |
| `new_os` | 過去に観測した OS 集合に含まれない |
| `new_browser` | 過去に観測したブラウザ集合に含まれない |
| `new_ip` | 過去に観測した IP 集合に含まれない |
| `missing_fingerprint` | クライアントから fingerprint が届かなかった |

## チャレンジ応答

```mermaid
sequenceDiagram
    autonumber
    participant U as ユーザ (ブラウザ)
    participant CW as composite WS
    participant R as Redis
    participant M as Mailer

    Note over U,M: 上のフローで issueChallenge 済み
    M->>U: メール「本人確認コード: 123456」(10 分有効)
    U->>CW: { type:"verify_code", code:"123456" }
    CW->>R: GET device_challenge:<deviceToken>
    alt コード一致 + attempts < 5
        CW->>R: DEL device_challenge:<deviceToken>
        CW->>CW: trusted_devices に INSERT or UPDATE
        CW-->>U: { type:"authenticated", authCode }
    else コード不一致
        CW->>R: SET (attempts++) KEEPTTL
        CW-->>U: { type:"state", state:"challenge_pending",<br/>  data:{ error, remainingAttempts } }
    else 5 回失敗 / 期限切れ
        CW->>R: DEL device_challenge:<deviceToken>
        CW-->>U: { type:"error", retryable:false }
        CW->>U: ws.end(4403)
    end

    opt リクエスト 「コード再送」
        U->>CW: { type:"resend" }
        CW->>R: 古い code を破棄、新コード生成、attempts=0
        CW->>M: 再送
        CW-->>U: { type:"state", data:{ resent:true } }
    end
```

## trusted_devices スキーマ

```sql
CREATE TABLE trusted_devices (
    id           UUID PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_hash  TEXT NOT NULL,                    -- SHA-256 hex
    label        TEXT NOT NULL,                    -- "macOS · Chrome 124"
    machine_info JSONB NOT NULL DEFAULT '{}',
    browser_info JSONB NOT NULL DEFAULT '{}',
    geo_info     JSONB NOT NULL DEFAULT '{}',      -- 撤去済みだが互換のため残置 (常に {})
    last_ip      TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at    TIMESTAMPTZ                      -- 信頼取消し用 (NULL = 有効)
);

CREATE UNIQUE INDEX idx_trusted_devices_user_hash_active
    ON trusted_devices (user_id, device_hash)
    WHERE revoked_at IS NULL;
```

`geo_info` カラムは AIFormat の DROP COLUMN 禁止ルールに従い残置するが、新規 INSERT は常に `{}` を入れる。

## メール送信

`server/src/auth/mailer.ts` 経由で SMTP / AWS SES に送信。送信先メールがない (例: GitHub アカウントで非公開メール) 場合はサーバコンソールにフォールバック表示する (テスト容易性)。

## レート / 試行制限

| 制限 | 値 |
|---|---|
| Challenge 有効期間 | 10 分 |
| 1 challenge あたり最大試行回数 | 5 |
| コード長 | 6 桁 (10 進、`crypto.randomInt`) |

## 旧仕様との差分 (2026-04-26)

- ❌ Geolocation API による緯度経度取得 → 撤去
- ❌ 緯度経度を 1 度に丸めた hash 入力 → 削除
- ❌ "Tokyo, JP" の地名ラベル → 削除
- ❌ `new_location` anomaly → 削除
- ✅ machine + browser + IP のみで識別
