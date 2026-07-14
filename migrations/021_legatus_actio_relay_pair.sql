-- ─────────────────────────────────────────────────────────────────────────
-- Legatus ↔ Actio の peer relay pair を許可する.
--
-- Legatus は v0.1 では outbound 専用 (caller) で Actio.tasks.create を呼ぶ。
-- 将来 Actio → Legatus の event push (例: タスク完了通知) を考慮し
-- bidirectional = TRUE にしておく (015 のコメント参照).
--
-- 双方が managed_projects に登録済 (legatus + actio とも 020 で seed)
-- であることが前提。これだけでは実際の channel は確立されない。
-- 各サービスが @ludiars/cernere-service-adapter の PeerAdapter を起動し、
-- 接続要求時に Cernere がこの行を見て pair の存在を確認する。
-- ─────────────────────────────────────────────────────────────────────────

INSERT INTO relay_pairs (from_project_key, to_project_key, bidirectional, is_active)
VALUES ('legatus', 'actio', TRUE, TRUE)
ON CONFLICT (from_project_key, to_project_key) DO UPDATE
SET bidirectional = EXCLUDED.bidirectional,
    is_active     = TRUE,
    updated_at    = now();
