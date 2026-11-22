import { useState } from "react";
import { credentialEnvNames } from "./project-login-settings";

interface Props {
  projectKey: string;
  /** 鍵を作り直す (managed_project rotate_secret)。新しい clientSecret は戻り値で 1 回だけ返る。 */
  onRotate: () => Promise<{ clientId: string; clientSecret: string }>;
}

/**
 * サービスの鍵 (client_secret) を作り直す欄。作り直すと前の鍵はすぐ使えなくなる。
 * 新しい鍵はこの画面に 1 回だけ出す (DB には hash だけを置く)。Excubitor の Vault の画面に貼り、
 * 使うサービスへ紐付ける。閉じると二度と表示できない。
 */
export function ProjectSecretRotationPanel({ projectKey, onRotate }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [issued, setIssued] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = credentialEnvNames(projectKey);

  const rotate = async () => {
    setError(null);
    setRotating(true);
    try {
      setIssued(await onRotate());
      setConfirming(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRotating(false);
    }
  };

  const copy = (value: string) => { void navigator.clipboard?.writeText(value); };

  return (
    <div style={{ marginBottom: "1rem", padding: "1rem", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "6px" }}>
      <h3 style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: "0.25rem" }}>サービスの鍵</h3>
      <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
        サービスが Cernere に自分を名乗るための鍵です。作り直すと前の鍵はすぐ使えなくなります。
        新しい鍵はこの画面に 1 回だけ表示されるので、Excubitor の Vault の画面で
        <code> {names.clientId} </code> と <code> {names.clientSecret} </code> に貼り、使うサービスに紐付けてください。
      </p>

      {issued ? (
        <div style={{ fontSize: "0.8rem" }}>
          <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>新しい鍵 (この画面を離れると二度と表示できません)</p>
          {[
            { name: names.clientId, value: issued.clientId },
            { name: names.clientSecret, value: issued.clientSecret },
          ].map((row) => (
            <div key={row.name} style={{ marginBottom: "0.5rem" }}>
              <div style={{ color: "var(--text-muted)" }}><code>{row.name}</code></div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <code style={{ wordBreak: "break-all", flex: 1 }}>{row.value}</code>
                <button onClick={() => copy(row.value)}>コピー</button>
              </div>
            </div>
          ))}
          <button onClick={() => setIssued(null)}>貼り終えたので閉じる</button>
        </div>
      ) : confirming ? (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.8rem", color: "var(--red)" }}>前の鍵は使えなくなります。作り直しますか？</span>
          <button className="primary" onClick={rotate} disabled={rotating}>{rotating ? "作っています…" : "作り直す"}</button>
          <button onClick={() => setConfirming(false)} disabled={rotating}>やめる</button>
        </div>
      ) : (
        <button onClick={() => setConfirming(true)}>鍵を作り直す</button>
      )}
      {error && <p style={{ fontSize: "0.8rem", color: "var(--red)", marginTop: "0.5rem" }}>{error}</p>}
    </div>
  );
}
