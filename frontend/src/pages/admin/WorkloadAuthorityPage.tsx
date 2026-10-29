/** Administrator enrollment surface. @implements SPEC-WORKLOAD-AUTHORITY */
import { Navigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { useWorkloadCommand } from "./workload/useWorkloadCommand";
import { RegistrationForm } from "./workload/RegistrationForm";
import { MonitorGrantForm } from "./workload/MonitorGrantForm";
import { RevocationForm } from "./workload/RevocationForm";
import { CommandReceipt } from "./workload/CommandReceipt";
import "./workload/workload.css";

export function WorkloadAuthorityPage() {
  const { user } = useAuth();
  if (!user || user.role !== "admin") return <Navigate to="/" replace />;
  // Account changes unmount the component that owns the one-time credential.
  return <WorkloadAdministration key={user.id} />;
}

function WorkloadAdministration() {
  const { wsConnected } = useAuth();
  const command = useWorkloadCommand();
  const disabled = !wsConnected || command.busy || command.uncertain || command.receipt !== null;
  return <main className="workload-admin">
    <h2>拠点認証</h2>
    <p>拠点の登録、監視の許可、不要になった登録の失効を行います。通信の設定と疎通確認は各拠点で別途必要です。</p>
    {!wsConnected && <p role="status">接続待ちです。接続が戻るまで操作できません。</p>}
    {command.busy && <p role="status">結果を待っています。再送やページ移動をしないでください。</p>}
    {command.message && <p role={command.uncertain ? "alert" : "status"}>{command.message}</p>}
    {command.receipt && <CommandReceipt receipt={command.receipt} dismiss={command.dismiss} />}
    <RegistrationForm disabled={disabled} send={command.send} />
    <MonitorGrantForm disabled={disabled} send={command.send} />
    <RevocationForm disabled={disabled} send={command.send} />
  </main>;
}
