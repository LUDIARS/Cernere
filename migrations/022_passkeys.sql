-- WebAuthn / Passkey クレデンシャル
--
-- FaceID / Touch ID / Windows Hello / Android 生体認証 / 物理セキュリティキー など
-- WebAuthn (FIDO2) で登録された公開鍵を保存する。
-- 1 ユーザに対して複数のクレデンシャルを登録可能 (例: iPhone と PC で別々)。
--
-- 仕様:
--  - credential_id は base64url 文字列 (= WebAuthn の binary ID をエンコード)
--  - public_key は COSE 形式 (bytea で保存、 verify 時に simplewebauthn が解釈)
--  - counter は signature counter (= 不正コピー検出用、 monotonic)
--  - device_type: 'singleDevice' (= platform 固定) / 'multiDevice' (= iCloud Keychain 等で同期)
--  - backed_up: true なら他端末にバックアップされた passkey
--  - transports: 利用可能なトランスポート [usb, nfc, ble, hybrid, internal] (jsonb 配列)

CREATE TABLE IF NOT EXISTS passkeys (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- WebAuthn credential ID (base64url)。 グローバルに一意でなければならない
    credential_id   TEXT NOT NULL,

    -- COSE key (bytea = simplewebauthn が返す Uint8Array)
    public_key      BYTEA NOT NULL,

    -- signature counter (= monotonic、 巻き戻りは攻撃の徴候)
    counter         BIGINT NOT NULL DEFAULT 0,

    -- 認証器の種類: 'singleDevice' (platform/USB) / 'multiDevice' (同期パスキー)
    device_type     TEXT NOT NULL DEFAULT 'singleDevice',

    -- iCloud Keychain / Google Password Manager 等で他端末に同期されているか
    backed_up       BOOLEAN NOT NULL DEFAULT false,

    -- 利用可能なトランスポート (jsonb 配列、 例: ["internal"] / ["usb","nfc"])
    transports      JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- 表示用ニックネーム (= プロフィール画面で「iPhone」「Yubikey 5C」 等の自由ラベル)
    nickname        TEXT,

    -- 認証器が報告した AAGUID (= モデル識別子、 表示用)
    aaguid          TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ
);

-- credential_id は WebAuthn 規格上 一意。 login 時に直接引く。
CREATE UNIQUE INDEX IF NOT EXISTS idx_passkeys_credential_id
    ON passkeys (credential_id);

-- ユーザごとの passkey 一覧 (プロフィール画面)
CREATE INDEX IF NOT EXISTS idx_passkeys_user
    ON passkeys (user_id, created_at DESC);
