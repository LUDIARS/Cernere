/**
 * Device Credential token の形式 (§7.2)。
 *
 * token は Cookie に載る外部入力なので、 壊れた入力で throw せず null になること、
 * および他方式の token を誤って受け入れないことを確認する。
 */

import { describe, expect, it } from "vitest";
import { formatDeviceToken, parseDeviceToken } from "../../src/auth/device-token.js";
import {
  DEVICE_COOKIE_NAME,
  buildDeviceCookie,
  clearDeviceCookie,
  readDeviceCookie,
} from "../../src/auth/device-cookie.js";

const DEVICE_ID = "11111111-2222-3333-4444-555555555555";

describe("parseDeviceToken", () => {
  it("組み立てた token を元に戻せる", () => {
    const token = formatDeviceToken(DEVICE_ID, "s3cr3t");
    expect(parseDeviceToken(token)).toEqual({ deviceId: DEVICE_ID, secret: "s3cr3t" });
  });

  it("secret に区切り文字が入っていても壊れない", () => {
    // base64url に '.' は現れないが、 分割実装が先頭 2 つの区切りだけを見ることを
    // 明示しておく。 将来 secret の符号化を変えた時にここが効く。
    const parsed = parseDeviceToken(formatDeviceToken(DEVICE_ID, "a.b.c"));
    expect(parsed?.secret).toBe("a.b.c");
  });

  it("別 version prefix を受け入れない", () => {
    // est1 は email session の token (§7.4)。 取り違えると別方式の資格情報を
    // device として検証しにいく。
    expect(parseDeviceToken(`est1.${DEVICE_ID}.secret`)).toBeNull();
  });

  it("壊れた入力は throw せず null", () => {
    for (const bad of ["", "cdt1", `cdt1.${DEVICE_ID}`, "cdt1..secret", "garbage", null, undefined]) {
      expect(parseDeviceToken(bad)).toBeNull();
    }
  });

  it("device_id が UUID でなければ拒否する", () => {
    expect(parseDeviceToken("cdt1.not-a-uuid.secret")).toBeNull();
  });
});

describe("device cookie", () => {
  it("非 loopback では __Host- prefix と Secure が付く", () => {
    const cookie = buildDeviceCookie("cdt1.x.y", "cernere.example.com");
    expect(cookie).toContain(`${DEVICE_COOKIE_NAME}=`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // __Host- は Domain 未指定が必須。 付けるとブラウザに拒否される。
    expect(cookie).not.toContain("Domain=");
  });

  it("削除 Cookie の属性が発行時と揃う", () => {
    // 属性がずれるとブラウザは別 Cookie とみなし、 消えない。
    const cleared = clearDeviceCookie("cernere.example.com");
    expect(cleared).toContain("Secure");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("SameSite=Strict");
    expect(cleared).toContain("Max-Age=0");
  });

  it("Cookie ヘッダから値を取り出せる", () => {
    const token = formatDeviceToken(DEVICE_ID, "s3cr3t");
    const header = `other=1; ${buildDeviceCookie(token, "cernere.example.com").split(";")[0]}; x=2`;
    expect(readDeviceCookie(header, "cernere.example.com")).toBe(token);
  });

  it("該当 Cookie が無ければ null", () => {
    expect(readDeviceCookie("other=1; x=2", "cernere.example.com")).toBeNull();
  });
});
