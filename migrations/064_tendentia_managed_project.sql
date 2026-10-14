-- Tendentia (トレンドマップ) を managed project として登録する。
--
-- Tendentia の画面は Cernere の埋め込みログイン (composite, popup) を使い、バックエンドが
-- POST /api/auth/exchange で authCode をユーザー token に替え、POST /api/auth/project-token
-- (project_key=tendentia, hub_url=Tendentia の公開 URL) で Tendentia 向けの user×project token
-- を発行してもらう (Aedilis と同じ形)。project-token は managed_projects の行が無いと拒否される。
--
-- Tendentia は project credentials で Cernere に接続しないので、client_secret は使い捨ての値で埋め、
-- launch credential の issuer 許可も置かない。user_data のカラムは持たない (好みの記録は
-- Tendentia 側の DB に Cernere の sub で持つ)。先例: 062 (tirocinium)。

INSERT INTO managed_projects (key, storage_slug, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
    'tendentia',
    'tendentia',
    'Tendentia',
    'Tendentia trend map service.',
    gen_random_uuid()::text,
    crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
    '{
        "project": {
            "key": "tendentia",
            "name": "Tendentia",
            "description": "Tendentia trend map service."
        },
        "data_sharing": [],
        "user_data": { "columns": {} }
    }'::jsonb
)
ON CONFLICT (key) DO NOTHING;
