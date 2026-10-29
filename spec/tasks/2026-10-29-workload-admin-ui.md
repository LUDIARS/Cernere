---
task: workload-admin-ui
project: Cernere
kind: 実装
created: 2026-10-29
memory_links: []
---
# Workload enrollment administration
## 目的
neco の正式認証整備と 2026-10-29 GOGO 指示に対応し、既存 workload_authority WS 管理操作を管理者画面から利用可能にする。
既存 authority 実装 task actio:907da54c-c82e-4a3c-83e0-19d330192d52 は完了済みの前提実装であり、この追加作業と混同しない。
## 完了条件
管理者専用ナビゲーションと画面から公開鍵登録、monitor の宛先限定 grant、主体・鍵・grant の失効を実行できる。秘密はページの一時メモリのみ。自動再送せず、応答不明時は再登録を止める。既存サーバー認可を維持する。審査・マージ・配備後の画面確認まで追跡する。
## スコープ
frontend/src、server/tests の UI 回帰、spec/feature/workload-authority.md。実拠点への鍵・TLS・grant 配備と疎通確認は Ex 側の正式認証作業として別途追跡する。
