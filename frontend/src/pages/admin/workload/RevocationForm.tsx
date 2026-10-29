import { useState, type FormEvent } from "react";
import type { WorkloadFormProps } from "./RegistrationForm";

/** @implements SPEC-WORKLOAD-AUTHORITY — explicit administrator revocation. */
export function RevocationForm({ disabled, send }: WorkloadFormProps) {
  const [action, setAction] = useState("revoke_principal");
  const [id, setId] = useState("");
  /** @implements SPEC-WORKLOAD-AUTHORITY — confirm irreversible revocation. */
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    if (window.confirm(`指定した登録を失効させます（${action}: ${id}）。元に戻せません。続けますか？`)) {
      void send(action, { id });
    }
  };
  return <section>
    <h3>登録・許可を失効</h3>
    <p>登録時の結果に記載された ID を指定します。拠点自体を失効させると、その拠点の認証が停止します。</p>
    <form onSubmit={submit}><fieldset disabled={disabled}>
      <label>対象<select value={action} onChange={e => { setAction(e.target.value); setId(""); }}>
        <option value="revoke_principal">拠点</option><option value="revoke_key">公開鍵</option><option value="revoke_grant">監視の許可</option>
      </select></label>
      <label>失効させる ID<input required maxLength={128} value={id} onChange={e => setId(e.target.value)} /></label>
      <button type="submit">内容を確認して失効</button>
    </fieldset></form>
  </section>;
}
