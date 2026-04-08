import { useContext } from "react";
import { CernereAuthContext } from "./provider.js";
import type { CernereAuthContextValue } from "./provider.js";

/**
 * Cernere 認証状態とアクションにアクセスするフック。
 * CernereAuthProvider の子孫で使用する。
 */
export function useCernereAuth(): CernereAuthContextValue {
  const ctx = useContext(CernereAuthContext);
  if (!ctx) {
    throw new Error("useCernereAuth must be used within a CernereAuthProvider");
  }
  return ctx;
}
