/**
 * Cernere の Discord Bot の設定 (admin、spec/feature/vob-discord-registration.md §4・§7)。
 * 正本は Cernere の DB の 1 行。Bot トークンは入力欄だけで、保存済みの値は表示しない (空のまま保存すると残す)。
 * スラッシュコマンド /register (/登録) の登録もここのボタンで行う。
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { discordBotApi, type DiscordBotSettingsView } from "../../lib/discord-bot-api";

const card: React.CSSProperties = {
  padding: "1rem", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "6px",
};
const field: React.CSSProperties = { display: "block", width: "100%", boxSizing: "border-box", marginTop: "0.25rem" };
const muted: React.CSSProperties = { color: "var(--text-muted)", fontSize: "0.85rem" };

interface FormState {
  enabled: boolean;
  applicationId: string;
  publicKeyHex: string;
  botToken: string;
  guildId: string;
  organizationId: string;
  adminChannelId: string;
  approvalWindowDays: string;
}

const EMPTY_FORM: FormState = {
  enabled: false, applicationId: "", publicKeyHex: "", botToken: "", guildId: "",
  organizationId: "", adminChannelId: "", approvalWindowDays: "7",
};

function formFrom(view: DiscordBotSettingsView): FormState {
  return {
    enabled: view.enabled,
    applicationId: view.applicationId ?? "",
    publicKeyHex: view.publicKeyHex ?? "",
    botToken: "",
    guildId: view.guildId ?? "",
    organizationId: view.organizationId ?? "",
    adminChannelId: view.adminChannelId ?? "",
    approvalWindowDays: String(view.approvalWindowDays),
  };
}

const orNull = (value: string): string | null => value.trim() || null;

export function DiscordBotPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [view, setView] = useState<DiscordBotSettingsView | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const next = await discordBotApi.get(); setView(next); setForm(formFrom(next)); setError(""); }
    catch (err) { setError((err as Error).message); }
  }, []);

  useEffect(() => { if (isAdmin) void load(); }, [isAdmin, load]);

  if (user && !isAdmin) return <Navigate to="/" replace />;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const token = form.botToken.trim();
      const next = await discordBotApi.update({
        enabled: form.enabled,
        applicationId: orNull(form.applicationId),
        publicKeyHex: orNull(form.publicKeyHex),
        ...(token ? { botToken: token } : {}),
        guildId: orNull(form.guildId),
        organizationId: orNull(form.organizationId),
        adminChannelId: orNull(form.adminChannelId),
        approvalWindowDays: Number(form.approvalWindowDays),
      });
      setView(next); setForm(formFrom(next));
      setNotice("保存しました。");
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const registerCommands = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await discordBotApi.registerCommands();
      setNotice(`スラッシュコマンドを登録しました: ${result.registered.map((name) => `/${name}`).join(", ") || "(なし)"}`);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const text = (key: Exclude<keyof FormState, "enabled">, label: string, placeholder = "", type = "text") => (
    <label style={{ display: "block", marginBottom: "0.5rem" }}>{label}
      <input style={field} type={type} value={form[key]} placeholder={placeholder} disabled={busy} autoComplete="off"
        onChange={(event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))} />
    </label>
  );

  const tokenHint = !view?.hasBotToken
    ? "未保存です。"
    : view.botTokenUnreadable
      ? "保存済みのトークンを読み出せません。入れ直してください。"
      : "保存済みです (表示しません)。変えるときだけ入力してください。";

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <h2>Discord Bot</h2>
      <p style={muted}>
        Discord のスラッシュコマンド <code>/register</code> (<code>/登録</code>) で一回限りの登録リンクを本人だけに返す Bot です。
        サーバーに参加して日が浅い人は、登録後に管理者の許可 (審査) が要ります。
      </p>
      {view && (
        <div style={card}>
          <p style={{ margin: 0 }}>状態: <strong>{view.ready ? "動作可能" : "無効 (設定が揃っていないか、無効にしています)"}</strong></p>
          <p style={{ ...muted, marginBottom: 0 }}>
            Discord Developer Portal の <strong>Interactions Endpoint URL</strong> には次を入れてください:<br />
            <code>{view.interactionsEndpointUrl}</code>
          </p>
          {view.updatedAt && <p style={{ ...muted, marginBottom: 0 }}>最終更新: {new Date(view.updatedAt).toLocaleString()}</p>}
        </div>
      )}
      {error && <p role="alert" style={{ color: "var(--red, #f85149)" }}>{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <form style={card} onSubmit={(event) => { void save(event); }}>
        <label style={{ display: "block", marginBottom: "0.75rem" }}>
          <input type="checkbox" checked={form.enabled} disabled={busy}
            onChange={(event) => setForm((prev) => ({ ...prev, enabled: event.target.checked }))} /> 有効にする
        </label>
        {text("applicationId", "Application ID", "123456789012345678")}
        {text("publicKeyHex", "Public Key (64 桁の hex)")}
        <label style={{ display: "block", marginBottom: "0.5rem" }}>Bot トークン
          <input style={field} type="password" value={form.botToken} disabled={busy} autoComplete="new-password"
            onChange={(event) => setForm((prev) => ({ ...prev, botToken: event.target.value }))} />
          <span style={muted}>{tokenHint}</span>
        </label>
        {text("guildId", "サーバー (guild) ID")}
        {text("organizationId", "登録した人を入れる Cernere の組織 ID (UUID)")}
        {text("adminChannelId", "管理者だけが見えるチャンネル ID (空なら通知しない)")}
        {text("approvalWindowDays", "サーバー参加から何日未満の人に管理者の許可を求めるか (0 で求めない)", "7", "number")}
        <button type="submit" disabled={busy}>保存</button>
      </form>
      <div style={card}>
        <p style={{ marginTop: 0 }}>保存済みの Application ID・Bot トークン・サーバー ID で、サーバーにスラッシュコマンドを登録します (何度押しても同じ内容で上書きします)。</p>
        <button type="button" disabled={busy} onClick={() => { void registerCommands(); }}>スラッシュコマンドを登録</button>
      </div>
    </div>
  );
}
