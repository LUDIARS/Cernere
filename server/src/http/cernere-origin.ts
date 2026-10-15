import { config } from "../config.js";

/** 要求元の Origin が Cernere 自身の画面か (Cernere 用の authCode 交換・同意の判断で使う)。 */
export function isCernereFrontendOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(config.frontendUrl).origin; } catch { return false; }
}
