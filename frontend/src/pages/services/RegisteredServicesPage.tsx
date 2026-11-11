import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { managedProjects, type UserProjectData } from "../../lib/api";
import { wsClient } from "../../lib/ws-client";
import { bodyTextStyle, messageStyle, pageStyle, panelStyle, panelTitleStyle } from "../../components/security/panel-styles";
import { formatDataValue, registeredServices, type UserProjectOverview } from "./registered-services";

/**
 * 一般メニュー「データを登録しているサービス」。自分のデータがどのサービスにあるかを確かめ、
 * オプトアウトは「データの設定」へ案内する。サービスの起動は置かない。
 * 読み込みに失敗したときは「登録なし」と誤解させないようエラーを出す。
 */
export function RegisteredServicesPage() {
  const { wsConnected } = useAuth();
  const [services, setServices] = useState<UserProjectOverview[] | null>(null);
  const [error, setError] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, UserProjectData>>({});
  const [detailError, setDetailError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const ov = await wsClient.sendCommand<UserProjectOverview[]>("managed_project", "overview");
      setServices(registeredServices(ov));
    } catch (e) {
      setServices(null);
      setError(`サービスの一覧を読み込めませんでした: ${(e as Error).message}`);
    }
  }, []);

  useEffect(() => { if (wsConnected) void load(); }, [wsConnected, load]);

  const toggle = async (key: string) => {
    if (openKey === key) { setOpenKey(null); return; }
    setOpenKey(key);
    setDetailError("");
    if (detail[key]) return;
    try {
      const data = await managedProjects.myData(key);
      setDetail((prev) => ({ ...prev, [key]: data }));
    } catch (e) {
      setDetailError(`登録データを読み込めませんでした: ${(e as Error).message}`);
    }
  };

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>データを登録しているサービス</h1>
      <p style={bodyTextStyle}>
        あなたのデータが Cernere に登録されているサービスです。渡すデータを止めたいときは
        <Link to="/data-optout">データの設定</Link> から変更できます。
        各サービスが自分の中だけに持っているデータは、ここには出ません。
      </p>
      {error && <div role="alert" style={messageStyle(true)}>{error} <button type="button" onClick={() => { void load(); }}>再読み込み</button></div>}
      {!wsConnected && <p role="status" style={bodyTextStyle}>接続しています…</p>}
      {services && services.length === 0 && <p style={bodyTextStyle}>データを登録しているサービスはまだありません。</p>}
      {services?.map((svc) => (
        <div key={svc.key} style={panelStyle}>
          <h2 style={panelTitleStyle}>{svc.name}</h2>
          {svc.description && <p style={bodyTextStyle}>{svc.description}</p>}
          <p style={bodyTextStyle}>登録されている項目: {svc.filledColumns} / {svc.totalColumns}</p>
          <button type="button" onClick={() => { void toggle(svc.key); }} aria-expanded={openKey === svc.key}>
            {openKey === svc.key ? "閉じる" : "登録データを見る"}
          </button>
          {" "}<Link to="/data-optout">データの設定</Link>
          {openKey === svc.key && detailError && <div role="alert" style={messageStyle(true)}>{detailError}</div>}
          {openKey === svc.key && detail[svc.key] && (
            <dl style={{ ...bodyTextStyle, marginTop: "0.75rem" }}>
              {Object.entries(detail[svc.key].schema).map(([column, def]) => (
                <div key={column} style={{ display: "flex", gap: "0.5rem" }}>
                  <dt style={{ fontWeight: 600 }}>{def.description || column}</dt>
                  <dd style={{ margin: 0 }}>{formatDataValue(detail[svc.key].data?.[column])}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ))}
    </main>
  );
}
