import { useState } from "react";
import { isDeviceEnrollmentDismissed, setDeviceEnrollmentDismissed } from "../../lib/device-enrollment-preference";
import { skipDeviceEnrollmentUrl } from "../../lib/passkey-enrollment";
import { bodyTextStyle, secondaryButton } from "../security/panel-styles";

/** Skipping resumes the ordinary login destination and its service authorization checks. */
export function DeviceEnrollmentPreference({ returnTo, busy }: { returnTo: string; busy: boolean }) {
  const [dismissed, setDismissed] = useState(isDeviceEnrollmentDismissed);
  return <section>
    <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
      <input type="checkbox" checked={dismissed} disabled={busy} onChange={event => {
        setDismissed(event.target.checked);
        setDeviceEnrollmentDismissed(event.target.checked);
      }} style={{ width: "1rem", height: "1rem", margin: 0, padding: 0 }} />
      次から表示しない
    </label>
    <p style={bodyTextStyle}>このブラウザでの案内を省略します。端末は設定からいつでも追加できます。</p>
    <button type="button" disabled={busy} style={secondaryButton(busy)} onClick={() => {
      window.location.assign(skipDeviceEnrollmentUrl(returnTo));
    }}>今は追加せずに続ける</button>
  </section>;
}
