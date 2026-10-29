import { useState, type FormEvent } from "react";
import type { WorkloadFormProps } from "./RegistrationForm";

/** @implements SPEC-WORKLOAD-AUTHORITY — administrator-owned monitor-only grant. */
export function MonitorGrantForm({ disabled, send }: WorkloadFormProps) {
  const [subject, setSubject] = useState("");
  const [audience, setAudience] = useState("");
  /** @implements SPEC-WORKLOAD-AUTHORITY — exact recipient and one direction. */
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    if (window.confirm(`${subject} から ${audience} への監視を許可します。逆方向は別の許可が必要です。続けますか？`)) {
      void send("grant", { subject, audience, action: "monitor", resource: `node:${audience}` });
    }
  };
  return <section>
    <h3>2. 監視を許可</h3>
    <p>登録済みの拠点を指定します。許可は片方向です。サービス操作や秘密情報の取得は許可しません。</p>
    <form onSubmit={submit}><fieldset disabled={disabled}>
      <label>監視する拠点 ID<input required maxLength={128} pattern="[a-z0-9][a-z0-9._\-]*/[a-z0-9][a-z0-9._\-]*" value={subject} onChange={e => setSubject(e.target.value)} /></label>
      <label>監視される拠点 ID<input required maxLength={128} pattern="[a-z0-9][a-z0-9._\-]*/[a-z0-9][a-z0-9._\-]*" value={audience} onChange={e => setAudience(e.target.value)} /></label>
      <button type="submit">内容を確認して許可</button>
    </fieldset></form>
  </section>;
}
