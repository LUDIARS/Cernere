/**
 * 許可待ち (pending) のユーザーを本人用の画面だけに留める (許可制 案 A)。
 *
 * サーバーは本人用以外の操作を approval_required で断るので、ここは表示の案内に過ぎない。
 * 状態が分かるまでは子をそのまま描画する (WS 接続前に画面を止めない)。
 */

import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { userAccess, type AccessStatus } from "../lib/user-access-api";

const ALLOWED_WHILE_PENDING = ["/access", "/profile", "/security", "/devices"];

export function AccessGate({ children }: { children: ReactNode }) {
  const { wsConnected } = useAuth();
  const location = useLocation();
  const [status, setStatus] = useState<AccessStatus | null>(null);

  useEffect(() => {
    if (!wsConnected) return;
    userAccess.status().then((s) => setStatus(s.status)).catch(() => setStatus(null));
  }, [wsConnected, location.pathname]);

  if (status && status !== "active" && !ALLOWED_WHILE_PENDING.includes(location.pathname)) {
    return <Navigate to="/access" replace />;
  }
  return <>{children}</>;
}
