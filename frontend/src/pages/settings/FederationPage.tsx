/**
 * 設定「アカウントの連携」(spec/plan/2026-10-15-account-federation-design.md §4.2 / §4.3 / §6)。
 *
 *   - 連携しているアカウント (端末ごとのアカウント) の一覧と主の選択 (今の主のパスキーで承認)
 *   - 端末を引き継ぐ: 招待 QR を出す / 新しい端末の QR を読む → 4 桁を照合してパスキーで承認
 *   - 外す (主による取り外し / 本人の離脱)
 *   - 既存の「別の端末を追加」(同じアカウントにパスキーを足す) との違いを並べて書く
 */

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { ApproveRequestPanel } from "../../components/federation/ApproveRequestPanel";
import { QrScanner } from "../../components/federation/QrScanner";
import { PairingPanel } from "../../components/security/PairingPanel";
import {
  bodyTextStyle, messageStyle, pageStyle, panelStyle, panelTitleStyle, primaryButton, secondaryButton,
} from "../../components/security/panel-styles";
import {
  federationApprover, federationErrorMessage, federationSettings, joinUrlKind, readJoinToken,
  type ApproverView, type FederationMember, type FederationView,
} from "../../lib/federation-api";

const POLL_MS = 2500;

const JOINED_VIA: Record<string, string> = {
  founder: "最初のアカウント",
  qr_new_device: "引き継ぎで追加",
  qr_existing_account: "既存のアカウントを連携",
};

function memberLabel(member: FederationMember): string {
  return member.displayName.trim() || `アカウント ${member.userId.slice(0, 8)}`;
}

export function FederationPage() {
  const [view, setView] = useState<FederationView | null>(null);
  const [request, setRequest] = useState<ApproverView | null>(null);
  const [inviteQr, setInviteQr] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await federationSettings.describe());
    } catch (e) {
      setError(federationErrorMessage(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const stopPolling = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stopPolling, []);

  // 招待 QR を出している間は、読まれたか (claimed) を見て承認の画面に切り替える。
  const watch = (requestId: string) => {
    stopPolling();
    timer.current = window.setInterval(() => {
      federationApprover.describe(requestId).then((next) => {
        setRequest(next);
        if (next.state !== "open") { stopPolling(); setInviteQr(""); }
      }).catch((e) => { setError(federationErrorMessage(e)); stopPolling(); setInviteQr(""); });
    }, POLL_MS);
  };

  const run = async (task: () => Promise<void>, done?: string) => {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      await task();
      if (done) setInfo(done);
    } catch (e) {
      setError(federationErrorMessage(e));
      if ((e as { code?: string }).code === "federation_revision_conflict") void load();
    } finally {
      setBusy(false);
    }
  };

  const showInvite = () => run(async () => {
    setScanning(false);
    const invite = await federationApprover.createInvite();
    setRequest({ requestId: invite.requestId, state: "open", kind: null, device: null, expiresIn: invite.expiresIn, joinerServices: [], approvalResource: invite.requestId });
    setInviteQr(await QRCode.toDataURL(invite.joinUrl, { width: 240, margin: 1 }));
    watch(invite.requestId);
  });

  const onScanned = (text: string): boolean => {
    if (joinUrlKind(text) === "join") {
      setError("これは「加わる側」で読む QR です。新しい端末で読んでください。");
      return false;
    }
    const token = readJoinToken(text);
    if (!token) return false;
    setScanning(false);
    void run(async () => { setRequest(await federationApprover.claim(token)); });
    return true;
  };

  const onRequestChange = (next: ApproverView) => {
    setRequest(next);
    if (next.state === "approved") {
      // 相手が完了させたら一覧に出る。しばらく読み直す。
      window.setTimeout(() => { void load(); }, 5000);
    }
  };

  const setPrimary = (member: FederationMember) => run(async () => {
    if (!view) return;
    setView(await federationSettings.setPrimary(view, member.userId));
  }, `${memberLabel(member)} を主にしました。サービスでの番号は変わりません。`);

  const remove = (member: FederationMember) => run(async () => {
    if (!view) return;
    const next = await federationSettings.remove(view, member.userId);
    setView(next);
  }, member.isSelf ? "この連携から抜けました。" : `${memberLabel(member)} を連携から外しました。`);

  const self = view?.members.find((m) => m.isSelf);
  const iAmPrimary = !view?.federationId || self?.isPrimary === true;

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>アカウントの連携</h1>
      <p style={bodyTextStyle}>
        端末ごとに作ったアカウントを 1 人の利用者として束ねます。どのアカウントで入っても、サービスには同じ利用者として伝わります。
        名前などの表示は「主」のアカウントのものを使います。
      </p>
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
      {info && <div style={messageStyle(false)}>{info}</div>}

      <div style={panelStyle}>
        <h2 style={panelTitleStyle}>🔗 連携しているアカウント</h2>
        {!view ? (
          <p style={bodyTextStyle}>読み込んでいます…</p>
        ) : !view.federationId ? (
          <p style={bodyTextStyle}>まだほかのアカウントと連携していません。下の「端末を引き継ぐ」から追加できます。</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {view.members.map((member) => (
              <li key={member.userId} style={{ padding: "0.6rem 0", borderTop: "1px solid var(--border)" }}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{memberLabel(member)}</strong>
                  {member.isPrimary && <span style={{ fontSize: "0.75rem", color: "var(--accent)" }}>主</span>}
                  {member.isSelf && <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>この端末</span>}
                </div>
                <div style={{ ...bodyTextStyle, marginBottom: "0.4rem" }}>
                  {JOINED_VIA[member.joinedVia] ?? member.joinedVia} ・ {new Date(member.joinedAt).toLocaleDateString()} ・ パスキー {member.passkeyCount} 個
                </div>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  {iAmPrimary && !member.isPrimary && (
                    <button type="button" onClick={() => { void setPrimary(member); }} disabled={busy} style={secondaryButton(busy)}>
                      主にする
                    </button>
                  )}
                  {(member.isSelf || (iAmPrimary && !member.isSelf)) && (
                    <button type="button" onClick={() => { void remove(member); }} disabled={busy} style={secondaryButton(busy)}>
                      {member.isSelf ? "この連携から抜ける" : "連携から外す"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {view?.federationId && (
          <p style={{ ...bodyTextStyle, marginTop: "0.75rem" }}>
            外したアカウントは、サービスでは別の利用者 (そのアカウント自身) に戻ります。連携で使っていたサービスのデータは連携に残ります。
          </p>
        )}
      </div>

      <div style={panelStyle}>
        <h2 style={panelTitleStyle}>📲 端末を引き継ぐ</h2>
        <p style={bodyTextStyle}>
          新しい端末でこのアカウントを使えるようにします。新しい端末には端末用のアカウントができ、この連携に加わります。
          カメラがある側で QR を読んでください。新しい端末に出る 4 桁を入れ、この端末のパスキーで承認します。
        </p>
        {!request || request.state === "locked" || request.state === "completed" ? (
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button type="button" onClick={() => { void showInvite(); }} disabled={busy} style={primaryButton(busy)}>
              QR を出す
            </button>
            <button type="button" onClick={() => { stopPolling(); setRequest(null); setScanning(true); }} disabled={busy} style={secondaryButton(busy)}>
              新しい端末の QR を読む
            </button>
          </div>
        ) : null}
        {inviteQr && request?.state === "open" && (
          <div style={{ textAlign: "center", marginTop: "0.75rem" }}>
            <img src={inviteQr} alt="新しい端末で読み取る QR コード" width={240} height={240} />
            <p style={bodyTextStyle}>新しい端末のカメラで読んでください。10 分で無効になります。他人に見せないでください。</p>
          </div>
        )}
        {scanning && <QrScanner onRead={onScanned} onCancel={() => setScanning(false)} />}
        <p style={{ ...bodyTextStyle, marginTop: "0.75rem" }}>
          既にある別のアカウントをこの連携に加えるときは、そのアカウントでログインした端末で <a href="/federate/join">/federate/join</a> を開き、
          この画面と QR でつないでください。そのアカウントで使っていたサービスのデータは連携へ移りません。
        </p>
      </div>
      {request && request.state !== "open" && <ApproveRequestPanel view={request} onChange={onRequestChange} />}

      <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginTop: "2rem" }}>同じアカウントにパスキーを足す (別の端末を追加)</h2>
      <p style={bodyTextStyle}>
        「端末を引き継ぐ」は端末ごとにアカウントを作って束ねます。こちらはこのアカウントそのものに別の端末のパスキーを足します。
        どちらでも、その端末から同じ利用者としてサービスを使えます。
      </p>
      <PairingPanel />
    </main>
  );
}
