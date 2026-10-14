/** tsx scripts/bootstrap-admin.ts <userId> — 指定ユーザーに admin を付ける (SPEC-ADMIN-BOOTSTRAP) */
import { install } from "@ludiars/vestigium";
import { grantAdminRole } from "../src/auth/admin-bootstrap.js";

const logging = install({ serviceCode: "cernere", captureConsole: true, pinoTransport: false });
process.env.CERNERE_DEV_LOG = "false";
let exitCode = 0;
try {
  const userId = process.argv[2];
  if (!userId) throw new Error("usage: tsx scripts/bootstrap-admin.ts <userId>");
  const result = await grantAdminRole(userId);
  const message = result.changed
    ? `granted admin to ${result.userId} (active passkeys: ${result.activePasskeys})`
    : `${result.userId} is already admin (active passkeys: ${result.activePasskeys})`;
  process.stdout.write(`${message}\n`);
  if (result.activePasskeys < 2) {
    process.stdout.write("warning: admin cannot use recovery QR; register a second passkey before relying on this account\n");
  }
  logging.writer.write({ level: "info", msg: message });
} catch (err) {
  exitCode = 1;
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  logging.writer.write({ level: "error", msg: message });
}
await logging.shutdown();
process.exit(exitCode);
