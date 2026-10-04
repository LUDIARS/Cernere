/**
 * 現地確認 MFA (method "onsite") の表示 (SPEC-MFA-ONSITE)。
 *
 *   1. Cernere から nonce と kiosk 一覧を受け取る (authApi.mfaOnsiteStart)
 *   2. 利用者が選んだ kiosk の LAN URL へ nonce だけを送る
 *   3. kiosk 前で顔 / パスキー確認 → kiosk が Cernere へ attestation を直送する
 *   4. 端末は MFA verify (method "onsite") を約 2 秒間隔で呼び、 409 onsite_pending の間は待つ
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import type { CompositeAuthApi, CompositeAuthResponse, OnsiteKiosk, OnsiteMfaStartResult } from "./auth-api.js";
import type { DeviceFingerprint } from "./device-fingerprint.js";
import type { CompositeLoginLabels } from "./login-labels.js";
import { hintStyle, inputStyle } from "./login-styles.js";
import { isOnsitePending, KioskBusyError, openKioskSession, readKioskSession } from "./onsite-kiosk-client.js";

const POLL_INTERVAL_MS = 2_000;

export interface OnsiteMfaSectionProps {
  mfaToken: string;
  authApi: CompositeAuthApi;
  labels: CompositeLoginLabels;
  device?: DeviceFingerprint;
  onResponse: (response: CompositeAuthResponse) => void;
}

interface ActiveSession { kiosk: OnsiteKiosk; sessionId: string }

export function OnsiteMfaSection(props: OnsiteMfaSectionProps): ReactElement {
  const { mfaToken, authApi, labels: l, device, onResponse } = props;
  const [challenge, setChallenge] = useState<OnsiteMfaStartResult | null>(null);
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  // Keep the latest callback without restarting the poll loop on every parent render.
  const respond = useRef(onResponse);
  respond.current = onResponse;
  // A nonce handed to a kiosk is bound to that kiosk session; a retry needs a fresh one.
  const nonceSpent = useRef(false);

  const start = async (): Promise<OnsiteMfaStartResult | null> => {
    if (!authApi.mfaOnsiteStart) { setMessage(l.onsiteUnsupported); return null; }
    try {
      const started = await authApi.mfaOnsiteStart({ mfaToken });
      setChallenge(started);
      return started;
    } catch (err) {
      setMessage(err instanceof Error ? err.message : l.onsiteUnsupported);
      return null;
    }
  };

  useEffect(() => { void start(); }, [mfaToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async (kiosk: OnsiteKiosk) => {
    setBusy(true); setMessage("");
    try {
      const current = nonceSpent.current ? await start() : challenge;
      if (!current) return;
      nonceSpent.current = false;
      const sessionId = await openKioskSession(kiosk.lanUrl, current.nonce);
      nonceSpent.current = true;
      setActive({ kiosk, sessionId });
    } catch (err) {
      setMessage(err instanceof KioskBusyError ? l.onsiteBusy : l.onsiteUnreachable);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!active || !authApi.mfaVerify) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await authApi.mfaVerify!({ mfaToken, method: "onsite", code: "", device });
        if (!stopped) { stopped = true; respond.current(response); }
        return;
      } catch (err) {
        if (stopped) return;
        if (!isOnsitePending(err)) {
          stopped = true;
          setActive(null);
          setMessage(err instanceof Error ? err.message : l.onsiteExpired);
          return;
        }
      }
      try {
        const state = await readKioskSession(active.kiosk.lanUrl, active.sessionId);
        if (stopped) return;
        if (state === "rejected" || state === "expired") {
          stopped = true;
          setActive(null);
          setMessage(state === "rejected" ? l.onsiteRejected : l.onsiteExpired);
          return;
        }
      } catch {
        // The kiosk status is display-only; Cernere's verify answer stays authoritative.
      }
      if (!stopped) timer = setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [active, authApi, mfaToken, device, l]);

  return (
    <div>
      <p style={hintStyle}>{l.onsiteIntro}</p>
      {message && <p role="status" style={hintStyle}>{message}</p>}
      {active ? (
        <p role="status" style={{ fontSize: "0.9rem" }}>
          {active.kiosk.label ?? active.kiosk.lanId} — {l.onsiteWaiting}
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {(challenge?.kiosks ?? []).map((kiosk) => (
            <li key={kiosk.lanId} style={{ marginBottom: "0.5rem" }}>
              <button type="button" disabled={busy} style={inputStyle} onClick={() => { void choose(kiosk); }}>
                {l.onsiteChooseKiosk}: {kiosk.label ?? kiosk.lanId} ({kiosk.placeId})
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
