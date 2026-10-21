/**
 * この端末を連携に加える (account-federation §4.1 / §4.2)。端末 B (または既存アカウント C) の画面。
 *
 *   - QR を出す: 使っている端末 A のカメラで読んでもらい、ここに出る 4 桁を A で入れてもらう
 *   - QR を読む: A が出した招待 QR をこの端末のカメラで読む (/federate/join#t=... で開いても同じ)
 * A が承認したら、新しい端末はここでパスキーを作ってアカウントを作り (名前は聞かない)、既存アカウントは
 * パスキーで本人確認して連携に加わる。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { QrScanner } from "../../components/federation/QrScanner";
import { ServiceUsageWarning } from "../../components/federation/ServiceUsageWarning";
import {
  bodyTextStyle, messageStyle, pageStyle, panelStyle, panelTitleStyle, primaryButton, secondaryButton,
} from "../../components/security/panel-styles";
import { getAccessToken } from "../../lib/browser-token-store";
import { isMobileDevice } from "../../lib/device-kind";
import {
  federationDevice, federationErrorMessage, joinUrlKind, readJoinToken,
  type DeviceTicket, type JoinState, type ServiceUsage,
} from "../../lib/federation-api";
import { readReturnPath } from "../onboarding/onboarding-return";

const POLL_MS = 2500;

export function JoinRequestPage({ newDevice = false }: { newDevice?: boolean } = {}) {
  const returnTo = readReturnPath(window.location.search);
  // A smartphone login on this browser is not the PC identity being enrolled.
  const loggedIn = !newDevice && getAccessToken() !== null;
  const mobile = isMobileDevice();
  const [ticket, setTicket] = useState<DeviceTicket | null>(null);
  const [qr, setQr] = useState("");
  const [state, setState] = useState<JoinState | null>(null);
  const [scanning, setScanning] = useState(false);
  const [services, setServices] = useState<ServiceUsage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<(() => Promise<void>) | null>(null);
  const timer = useRef<number | null>(null);

  const stopPolling = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stopPolling, []);

  const claimInvite = useCallback(async (token: string) => {
    setBusy(true);
    setError("");
    try {
      const claimed = await federationDevice.claimInvite(token, newDevice);
      setTicket(claimed);
      setState("claimed");
      setQr("");
    } catch (e) {
      setError(federationErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [newDevice]);

  // A の招待 QR をカメラアプリで読んで開いた (#t=)。token は fragment から読み、履歴から消す。
  useEffect(() => {
    const token = readJoinToken(window.location.href);
    if (!token || !window.location.hash) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    void claimInvite(token);
  }, [claimInvite]);

  // 既存アカウントとして加わるときは、承認前に「このアカウントで使っていたサービス」を見せる (§4.2)。
  useEffect(() => {
    if (!loggedIn) return;
    federationDevice.myServices().then(setServices).catch(() => setServices([]));
  }, [loggedIn]);

  useEffect(() => {
    if (!ticket) return;
    stopPolling();
    timer.current = window.setInterval(() => {
      federationDevice.status(ticket).then((next) => {
        setState(next.state);
        if (next.state !== "open" && next.state !== "claimed") stopPolling();
        if (next.state !== "open") setQr("");
      }).catch((e) => { setError(federationErrorMessage(e)); stopPolling(); });
    }, POLL_MS);
    return stopPolling;
  }, [ticket]);

  const showQr = async () => {
    setBusy(true);
    setError("");
    try {
      const created = await federationDevice.createRequest(newDevice);
      setTicket(created);
      setState("open");
      setQr(await QRCode.toDataURL(created.approveUrl, { width: 260, margin: 1 }));
    } catch (e) {
      setError(federationErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onScanned = (text: string): boolean => {
    if (joinUrlKind(text) === "approve") {
      setError("これは「承認する側」で読む QR です。使っている端末で読んでください。");
      return false;
    }
    const token = readJoinToken(text);
    if (!token) return false;
    setScanning(false);
    void claimInvite(token);
    return true;
  };

  const complete = async () => {
    if (!ticket) return;
    setBusy(true);
    setError("");
    try {
      if (loggedIn) {
        await federationDevice.completeAsExistingAccount(ticket);
        window.location.assign("/settings/federation");
      } else {
        if (!prepared) {
          const save = await federationDevice.prepareNewDevice(ticket, newDevice);
          setPrepared(() => save);
          setBusy(false);
          return;
        }
        setPrepared(null);
        await prepared();
        // 名前は聞かない (主の名前を使う)。リカバリー QR と通知だけを設定する。
        window.location.assign(`/onboarding?${new URLSearchParams({ return: returnTo, federated: "1" }).toString()}`);
      }
    } catch (e) {
      setError(federationErrorMessage(e));
      setBusy(false);
    }
  };

  const restart = () => {
    setPrepared(null);
    stopPolling();
    setTicket(null);
    setState(null);
    setQr("");
    setError("");
  };

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>
        {loggedIn ? "このアカウントをほかのアカウントと連携する" : "この端末を引き継ぐ"}
      </h1>
      <p style={bodyTextStyle}>
        いま使っている端末 (Cernere にログインしている端末) と QR でつなぎます。カメラがある側で読み、無い側で QR を出してください。
      </p>
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
      {loggedIn && services && <ServiceUsageWarning services={services} subject="このアカウント" />}

      {!ticket && !scanning && (
        <div style={panelStyle}>
          <h2 style={panelTitleStyle}>📷 どちらで読みますか</h2>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button type="button" onClick={() => { void showQr(); }} disabled={busy} style={primaryButton(busy)}>
              この端末に QR を出す
            </button>
            <button type="button" onClick={() => setScanning(true)} disabled={busy} style={mobile ? primaryButton(busy) : secondaryButton(busy)}>
              カメラで QR を読む
            </button>
          </div>
          <p style={{ ...bodyTextStyle, marginTop: "0.75rem" }}>
            「カメラで QR を読む」は、使っている端末の 設定 →「アカウントの連携」→「端末を引き継ぐ (QR を出す)」で出した QR を読みます。
          </p>
        </div>
      )}

      {scanning && (
        <div style={panelStyle}>
          <h2 style={panelTitleStyle}>📷 使っている端末の QR を読む</h2>
          <QrScanner onRead={onScanned} onCancel={() => setScanning(false)} />
        </div>
      )}

      {ticket && (state === "open" || state === "claimed") && (
        <div style={panelStyle}>
          {qr && state === "open" && (
            <div style={{ textAlign: "center" }}>
              <img src={qr} alt="使っている端末で読み取る QR コード" width={260} height={260} />
              <p style={bodyTextStyle}>使っている端末のカメラで読んでください。この QR は 10 分で無効になります。他人に見せないでください。</p>
            </div>
          )}
          <p style={{ ...bodyTextStyle, color: "var(--text)" }}>使っている端末で、次の番号を入力してください:</p>
          <p style={{ fontSize: "2rem", fontFamily: "monospace", letterSpacing: "0.4em", textAlign: "center" }} aria-label="確認の番号">
            {ticket.code}
          </p>
          <p style={bodyTextStyle}>承認を待っています…</p>
        </div>
      )}

      {ticket && state === "approved" && (
        <div style={panelStyle}>
          <h2 style={panelTitleStyle}>✅ 承認されました</h2>
          <p style={bodyTextStyle}>
            {loggedIn
              ? "このアカウントのパスキーで本人確認すると連携します。"
              : "この端末にパスキーを作ると、いま使っているアカウントと同じ利用者としてサービスを使えます。名前は入力しなくてかまいません。"}
          </p>
          <button type="button" onClick={() => { void complete(); }} disabled={busy} style={primaryButton(busy)}>
            {busy ? "処理中…" : loggedIn ? "パスキーで確認して連携する" : prepared ? "この端末に保存して連携する" : "登録を準備する"}
          </button>
        </div>
      )}

      {(state === "locked" || state === "completed") && (
        <div style={panelStyle}>
          <p style={bodyTextStyle}>{state === "locked" ? "番号の入力に失敗したため、この引き継ぎは無効になりました。" : "この引き継ぎは完了しています。"}</p>
          <button type="button" onClick={restart} style={secondaryButton(false)}>最初からやり直す</button>
        </div>
      )}
    </main>
  );
}
