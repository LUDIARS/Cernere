/** Cookie issuance and mutations require a configured browser Origin. @implements SPEC-DEVICE-SESSION */
import { config } from "../config.js";
import { AppError } from "../error.js";

export function assertDeviceOrigin(origin: string): void {
  if (!origin) throw AppError.forbidden("Origin header is required");
  const allowed = config.webauthnOrigins.map(value => value.trim().replace(/\/+$/, "")).filter(Boolean);
  if (!allowed.includes(origin)) throw AppError.forbidden("Origin is not allowed");
}
