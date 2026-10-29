import type { WorkloadReceipt } from "./useWorkloadCommand";

/** @implements SPEC-WORKLOAD-AUTHORITY — one-time credentials stay in page memory. */
export function CommandReceipt({ receipt, dismiss }: { receipt: WorkloadReceipt; dismiss: () => void }) {
  return <section aria-label="操作結果">
    <h3>操作結果</h3>
    {"id" in receipt && <p>ID: <code>{receipt.id}</code></p>}
    {"client_secret" in receipt && <>
      <p>秘密情報はこの画面で一度だけ表示します。対象拠点の Vault に保管してください。閉じたりページを離れたりすると再表示できません。</p>
      <p>鍵 ID: <code>{receipt.key_id}</code></p>
      <p>クライアント ID: <code>{receipt.client_id}</code></p>
      <details><summary>クライアントの秘密情報を表示</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{receipt.client_secret}</pre></details>
    </>}
    {"revoked" in receipt && <p>{receipt.revoked ? "失効処理を受け付けました。" : "失効を確認できませんでした。"}</p>}
    <button onClick={dismiss}>結果を確認して閉じる</button>
  </section>;
}
