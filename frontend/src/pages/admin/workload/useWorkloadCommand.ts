/** Serial, non-retrying workload mutations. @implements SPEC-WORKLOAD-AUTHORITY */
import { useEffect, useRef, useState } from "react";
import { wsClient } from "../../../lib/ws-client";

export interface RegistrationReceipt {
  id: string;
  key_id: string;
  client_id: string;
  client_secret: string;
}
export type WorkloadReceipt = RegistrationReceipt | { id: string } | { revoked: boolean };

/** @implements SPEC-WORKLOAD-AUTHORITY — serialized mutations without automatic retry. */
export function useWorkloadCommand() {
  const [receipt, setReceipt] = useState<WorkloadReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);

  /** @implements SPEC-WORKLOAD-AUTHORITY — one submission, one transient receipt. */
  const send = async (action: string, payload: Record<string, unknown>): Promise<void> => {
    // Ref closes the same-render double-click window. A receipt must be dismissed first.
    if (inFlight.current || receipt || uncertain || !wsClient.connected) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    /** @implements SPEC-WORKLOAD-AUTHORITY — ambiguous outcomes block resubmission. */
    const markUncertain = () => {
      if (!mounted.current) return;
      setUncertain(true);
      setMessage("処理結果を確認できません。再送せず、管理者が監査記録と登録状態を確認してください。画面の再読み込みは再送の許可にはなりません。");
    };
    timer.current = setTimeout(markUncertain, 30_000);
    try {
      const result = await wsClient.sendCommand<WorkloadReceipt>("workload_authority", action, payload);
      if (!mounted.current) return;
      setReceipt(result);
      setMessage("処理が完了しました。結果を確認してください。");
      setUncertain(false);
      inFlight.current = false;
    } catch {
      // A transport/audit failure does not establish that the transaction was rolled back.
      // Do not display raw errors or permit retry of a possibly committed mutation.
      markUncertain();
    } finally {
      clearTimeout(timer.current);
      if (mounted.current) setBusy(false);
    }
  };
  return { receipt, busy, uncertain, message, send, dismiss: () => setReceipt(null) };
}
