-- ─────────────────────────────────────────────────────────────────────────
-- Memoria ↔ Imperativus の peer relay pair を許可する.
--
-- bidirectional = TRUE なので 1 行で双方向を表現する (015 のコメント参照).
-- 双方が managed_projects に登録済 (017 で seed) であることが前提.
--
-- これだけでは実際の channel は確立されない. 各サービスが
-- @ludiars/cernere-service-adapter の PeerAdapter を起動し、
-- 接続要求時に Cernere がこの行を見て pair の存在を確認する.
-- ─────────────────────────────────────────────────────────────────────────

INSERT INTO relay_pairs (from_project_key, to_project_key, bidirectional, is_active)
VALUES ('memoria', 'imperativus', TRUE, TRUE)
ON CONFLICT (from_project_key, to_project_key) DO UPDATE
SET bidirectional = EXCLUDED.bidirectional,
    is_active     = TRUE,
    updated_at    = now();
