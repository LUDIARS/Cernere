// Excubitor の data-export / data-import 入口。 Cernere は拠点間のデータ移行をまだ持たない。
// 個人データの単一情報源なので、 no-op の成功にはせず非 0 で止める。
// 移行が必要な場合は、 サービス所有の検証済みバックアップ／復元手順を別途用意すること。
console.error("Cernere data migration is not implemented. Use an approved service-owned backup and restore procedure.");
process.exit(1);
