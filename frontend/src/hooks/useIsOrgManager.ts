import { useEffect, useState } from "react";
import { wsClient } from "../lib/ws-client";
import { isOrgManagerRole } from "../components/nav-items";

/**
 * どこかの組織でリーダー以上か (メニューの「組織」を出すかどうかだけに使う)。
 * 読み込みに失敗したら出さない。操作の可否は server が都度判定する。
 */
export function useIsOrgManager(enabled: boolean): boolean {
  const [manager, setManager] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    wsClient.sendCommand<Array<{ myRole?: string }>>("organization", "list")
      .then((orgs) => { if (alive) setManager(orgs.some((org) => isOrgManagerRole(org.myRole))); })
      .catch(() => { if (alive) setManager(false); });
    return () => { alive = false; };
  }, [enabled]);
  return manager;
}
