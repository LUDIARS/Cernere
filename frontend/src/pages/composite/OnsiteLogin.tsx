import { useEffect, useRef, useState } from "react";
import { beginOnsite, contactKiosk, finishOnsite, onsiteAvailable, type OnsiteTicket } from "../../lib/composite-onsite";

export function OnsiteLogin({ onActive }: { onActive: (active: boolean) => void }) {
  const [available, setAvailable] = useState(false);
  const [ticket, setTicket] = useState<OnsiteTicket | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    const check = new AbortController();
    void onsiteAvailable(check.signal).then(ok => { if (!check.signal.aborted) setAvailable(ok); })
      .catch(() => { /* Other login methods remain available when onsite capability cannot be verified. */ });
    return () => { check.abort(); operation.current?.abort(); };
  }, []);

  function reset() {
    operation.current?.abort();
    operation.current = null;
    setTicket(null);
    setWorking(false);
    setWaiting(false);
    onActive(false);
  }

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setWorking(true);
    setMessage("");
    onActive(true);
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try { await action(controller.signal); }
    catch (error) {
      if (operation.current === controller) {
        reset();
        setMessage(error instanceof Error && error.name !== "AbortError" ? error.message : "処理を確認できません。もう一度開始してください。");
      }
    } finally {
      window.clearTimeout(timeout);
      if (operation.current === controller) { operation.current = null; setWorking(false); }
    }
  }

  if (!available) return null;
  return <section aria-label="会場 Wi-Fi でのログイン">
    {!ticket && <button type="button" disabled={working} onClick={() => void run(async signal => {
      const result = await beginOnsite(signal);
      signal.throwIfAborted();
      setTicket(result);
    })}>現在の Cernere アカウントで会場の Os を使う</button>}
    {ticket && !waiting && <>
      <p>同じ Wi-Fi に接続し、本人確認する会場端末を選んでください。</p>
      {ticket.kiosks.map(kiosk => <button key={kiosk.lanId} type="button" disabled={working}
        onClick={() => void run(async signal => {
          await contactKiosk(ticket, kiosk, signal);
          signal.throwIfAborted();
          setWaiting(true);
        })}>{kiosk.label || kiosk.lanId}</button>)}
    </>}
    {ticket && waiting && <button type="button" disabled={working} onClick={() => void run(async signal => {
      const state = await finishOnsite(ticket, signal);
      signal.throwIfAborted();
      if (state === "pending") setMessage("会場の端末で本人確認してから、もう一度押してください。");
      else { reset(); setMessage("GLab に認証結果を送りました。"); }
    })}>会場端末での本人確認を完了した</button>}
    {ticket && <button type="button" disabled={working} onClick={() => { reset(); setMessage(""); }}>キャンセル</button>}
    {message && <p role="status">{message}</p>}
  </section>;
}
