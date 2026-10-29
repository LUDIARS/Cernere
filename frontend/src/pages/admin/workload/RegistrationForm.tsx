import { useState, type FormEvent } from "react";

export interface WorkloadFormProps {
  disabled: boolean;
  send: (action: string, payload: Record<string, unknown>) => Promise<void>;
}

/** @implements SPEC-WORKLOAD-AUTHORITY — enrollment accepts public keys only. */
export function RegistrationForm({ disabled, send }: WorkloadFormProps) {
  const [id, setId] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [error, setError] = useState("");
  /** @implements SPEC-WORKLOAD-AUTHORITY — refuse private material before transport. */
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    const pem = publicKey.trim();
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----$/.test(pem)) {
      setError("Ed25519 の公開鍵（BEGIN PUBLIC KEY）を入力してください。秘密鍵は送信できません。");
      return;
    }
    setError("");
    if (window.confirm(`拠点 ${id} を登録します。認証用の秘密情報は一度だけ表示されます。続けますか？`)) {
      void send("register", { id, publicKeyPem: pem });
    }
  };
  return <section>
    <h3>1. 拠点を登録</h3>
    <p>拠点側で作成した公開鍵を登録します。秘密鍵は入力しないでください。</p>
    <form onSubmit={submit} autoComplete="off"><fieldset disabled={disabled}>
      <label>拠点 ID（例: hq/excubitor）<input required maxLength={128} pattern="[a-z0-9][a-z0-9._\-]*/[a-z0-9][a-z0-9._\-]*" value={id} onChange={e => setId(e.target.value)} /></label>
      <label>Ed25519 公開鍵（SPKI PEM）<textarea required rows={5} maxLength={4096} spellCheck={false} value={publicKey} onChange={e => setPublicKey(e.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <button type="submit">内容を確認して登録</button>
    </fieldset></form>
  </section>;
}
