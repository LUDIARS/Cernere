/**
 * 登録画面の会場確認の表示 (spec/feature/venue-network-registration.md §2)。
 * 会場の外では「会場の Wi-Fi に接続してください」を出し、会場外として登録を続ける選択も出す (例外経路)。
 */

import { bodyTextStyle, messageStyle, panelStyle, panelTitleStyle, secondaryButton } from "../../components/security/panel-styles";
import type { VenueCheckState } from "../../lib/venue-check";

const MESSAGES: Record<VenueCheckState["phase"], string> = {
  starting: "会場のネットワークを確認しています…",
  checking: "会場のネットワークを確認しています…",
  unreachable: "会場の Wi-Fi に接続してください。接続すると自動で確認します。",
  verified: "会場のネットワークを確認しました。この会場の組織のメンバーとして登録します。",
  expired: "会場のネットワークを確認できませんでした。会場の Wi-Fi に接続してから、もう一度確かめてください。",
  unavailable: "いまは会場の確認ができません。",
};

interface Props {
  state: VenueCheckState;
  outsideVenue: boolean;
  busy: boolean;
  onRetry(): void;
  onOutsideVenueChange(value: boolean): void;
}

export function VenueCheckPanel({ state, outsideVenue, busy, onRetry, onOutsideVenueChange }: Props) {
  const verified = state.phase === "verified";
  const canRetry = state.phase === "expired" || state.phase === "unavailable" || state.phase === "unreachable";
  return (
    <div style={panelStyle}>
      <h2 style={panelTitleStyle}>📶 会場の確認</h2>
      <div role="status" style={messageStyle(!verified && state.phase !== "starting" && state.phase !== "checking")}>
        {MESSAGES[state.phase]}
      </div>
      {canRetry && (
        <button type="button" onClick={onRetry} disabled={busy} style={{ ...secondaryButton(busy), marginTop: "0.5rem" }}>
          もう一度確かめる
        </button>
      )}
      {!verified && (
        <label style={{ ...bodyTextStyle, display: "flex", gap: "0.5rem", alignItems: "flex-start", marginTop: "0.75rem" }}>
          <input type="checkbox" checked={outsideVenue} disabled={busy}
            onChange={(e) => onOutsideVenueChange(e.target.checked)} />
          <span>
            会場の外から登録を続ける (例外)。管理者が確認するまで使えず、確認の結果、登録が認められないことがあります。
          </span>
        </label>
      )}
    </div>
  );
}
