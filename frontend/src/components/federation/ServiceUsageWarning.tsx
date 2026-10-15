/**
 * 既存アカウントを連携に加える前の警告 (account-federation §4.2)。
 * そのアカウントの番号で保存されたサービスのデータは連携の番号へ移らない (自動で混ぜない)。
 */

import type { ServiceUsage } from "../../lib/federation-api";
import { messageStyle } from "../security/panel-styles";

export function ServiceUsageWarning({ services, subject }: { services: ServiceUsage[]; subject: string }) {
  if (services.length === 0) {
    return <div style={messageStyle(false)}>{subject}で使っていたサービスはありません。</div>;
  }
  return (
    <div role="note" style={messageStyle(true)}>
      {subject}で使っていたサービス: <strong>{services.map((s) => s.name).join("、")}</strong>。
      連携後は連携の番号で扱われ、{subject}で保存されていたデータは見えなくなります (データは移りません)。
    </div>
  );
}
