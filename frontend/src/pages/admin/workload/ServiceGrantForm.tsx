import { useState, type FormEvent } from "react";
import type { WorkloadFormProps } from "./RegistrationForm";
import { OPERATION_VERBS, buildGrantPayload, describeGrant, type GrantKind, type OperationVerb } from "./grant-input";

const KIND_LABELS: Record<GrantKind, string> = {
  operation: "サービス操作（operation）",
  "hq-config": "HQ 設定の取得（hq-config）",
  vault: "秘密情報の取得（vault）",
  bundle: "リポジトリ取得（bundle）",
};
const ID_PATTERN = "[a-z0-9][a-z0-9._\\-]*/[a-z0-9][a-z0-9._\\-]*";

/** @implements SPEC-WORKLOAD-AUTHORITY — administrator-owned operation/hq-config/vault/bundle grant. */
export function ServiceGrantForm({ disabled, send }: WorkloadFormProps) {
  const [kind, setKind] = useState<GrantKind>("operation");
  const [subject, setSubject] = useState("");
  const [audience, setAudience] = useState("");
  const [verb, setVerb] = useState<OperationVerb>("restart");
  const [code, setCode] = useState("");
  const [repository, setRepository] = useState("");
  const [keys, setKeys] = useState("");
  const [error, setError] = useState("");
  /** @implements SPEC-WORKLOAD-AUTHORITY — validate and confirm before one transmission. */
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    const built = buildGrantPayload({ kind, subject, audience, verb, code, repository, keys });
    if (!built.ok) { setError(built.error); return; }
    setError("");
    if (window.confirm(describeGrant(built.payload))) void send("grant", { ...built.payload });
  };
  return <section>
    <h3>3. 操作・取得を許可</h3>
    <p>登録済みの拠点に、宛先の拠点でのサービス操作、HQ 設定・秘密情報・リポジトリの取得を許可します。許可は片方向で、選んだ 1 つの操作と対象だけに限られます。</p>
    <form onSubmit={submit} autoComplete="off"><fieldset disabled={disabled}>
      <label>許可の種類<select value={kind} onChange={e => { setKind(e.target.value as GrantKind); setError(""); }}>
        {(Object.keys(KIND_LABELS) as GrantKind[]).map(k => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
      </select></label>
      <label>許可を受ける拠点 ID<input required maxLength={128} pattern={ID_PATTERN} value={subject} onChange={e => setSubject(e.target.value)} /></label>
      <label>宛先の拠点 ID<input required maxLength={128} pattern={ID_PATTERN} value={audience} onChange={e => setAudience(e.target.value)} /></label>
      {kind === "operation" && <label>操作<select value={verb} onChange={e => setVerb(e.target.value as OperationVerb)}>
        {OPERATION_VERBS.map(v => <option key={v} value={v}>{v}</option>)}
      </select></label>}
      {(kind === "operation" || kind === "vault") && <label>サービスコード（例: excubitor。service: は自動で付きます）
        <input required maxLength={120} spellCheck={false} value={code} onChange={e => setCode(e.target.value)} /></label>}
      {kind === "hq-config" && <p>対象は service:concordia に固定です。</p>}
      {kind === "bundle" && <label>リポジトリ（owner/name。repository: は自動で付きます）
        <input required maxLength={200} spellCheck={false} value={repository} onChange={e => setRepository(e.target.value)} /></label>}
      {kind === "vault" && <label>取得を許可する秘密情報の名前（1 行に 1 つ、500 個まで）
        <textarea required rows={5} spellCheck={false} value={keys} onChange={e => setKeys(e.target.value)} /></label>}
      {error && <p role="alert">{error}</p>}
      <button type="submit">内容を確認して許可</button>
    </fieldset></form>
  </section>;
}
