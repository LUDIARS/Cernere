-- 信頼済みデバイス管理 (本人確認)
--
-- ログイン成功後、マシン情報・ブラウザ情報・位置情報をハッシュ化して
-- ユーザーごとに記録する。普段と異なる環境からのアクセス時には
-- メールで送信した確認コードによる追加認証を要求する。

CREATE TABLE IF NOT EXISTS trusted_devices (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- マシン + ブラウザ + 大まかな位置 を正規化した SHA-256 (hex)
    device_hash     TEXT NOT NULL,

    -- 表示用の人間可読ラベル (例: "macOS · Chrome 124 · Tokyo, JP")
    label           TEXT NOT NULL,

    -- 詳細情報 (UA, Platform, スクリーン解像度, タイムゾーン, 言語等)
    machine_info    JSONB NOT NULL DEFAULT '{}'::jsonb,
    browser_info    JSONB NOT NULL DEFAULT '{}'::jsonb,
    geo_info        JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- 最終アクセス情報
    last_ip         TEXT,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- 信頼を取り消した時刻 (NULL = 有効)
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_user
    ON trusted_devices (user_id);

-- 同じユーザー × 同じデバイスハッシュは active で 1 件のみ
CREATE UNIQUE INDEX IF NOT EXISTS idx_trusted_devices_user_hash_active
    ON trusted_devices (user_id, device_hash)
    WHERE revoked_at IS NULL;

-- 直近のサインイン履歴 (最新順) 取得用
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user_last_seen
    ON trusted_devices (user_id, last_seen_at DESC);
