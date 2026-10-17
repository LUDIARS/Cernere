import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompositeLoginPage } from "../../../frontend/src/pages/composite/CompositeLoginPage";
import { RecoveryEntryPage } from "../../../frontend/src/pages/RecoveryEntryPage";
import { hasLoginCookie, rememberLoginCookie } from "../../../frontend/src/lib/login-cookie";

const session = vi.hoisted(() => vi.fn(() => { throw new Error("Authentication started before login click"); }));
vi.mock("../../../frontend/src/hooks/useCompositeLoginSession", () => ({ useCompositeLoginSession: session }));
vi.mock("@ludiars/cernere-composite/ui", () => ({ CompositeLogin: () => { throw new Error("WebAuthn UI mounted before login click"); } }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("explicit Cernere login entry", () => {
  it.each([true, false])("does not start authentication on opening (self=%s)", (self) => {
    vi.stubGlobal("window", { location: {
      origin: "https://cernere.example.com",
      pathname: self ? "/login" : "/composite/login",
      search: self ? "?redirect=%2Fprofile" : "?origin=https%3A%2F%2Fglab.example.com",
    } });
    vi.stubGlobal("document", { cookie: "" });
    const html = renderToStaticMarkup(createElement(CompositeLoginPage, { self }));
    expect(session).not.toHaveBeenCalled();
    expect(html).toContain("スマホでログイン</button>");
    expect(html).toContain("新規アカウントで登録します");
    expect(html).toContain("この端末のパスキーを登録して連携");
    expect(html).toContain('checked=""');
    expect(html).toContain('href="/recover"');
  });
  it("shows normal passkey login for returning cookies without starting authentication", () => {
    vi.stubGlobal("window", { location: { pathname: "/login", search: "", origin: "https://cernere.example.com" } });
    vi.stubGlobal("document", { cookie: "cernere_returning=1" });
    const html = renderToStaticMarkup(createElement(CompositeLoginPage, { self: true }));
    expect(html).toContain("パスキーでログイン");
    expect(html).not.toContain("スマホでログイン");
    expect(session).not.toHaveBeenCalled();
  });
  it("does not mistake infrastructure cookies for a returning account", () => {
    vi.stubGlobal("document", { cookie: "cf_clearance=opaque; __cf_bm=opaque" });
    expect(hasLoginCookie()).toBe(false);
  });
  it("stores a non-secret returning hint after successful login", () => {
    vi.stubGlobal("document", { cookie: "" });
    vi.stubGlobal("window", { location: { protocol: "https:" } });
    rememberLoginCookie();
    expect(document.cookie).toContain("cernere_returning=1;");
    expect(document.cookie).toContain("; Secure");
  });
  it("offers QR recovery and administrator contact", () => {
    const html = renderToStaticMarkup(createElement(RecoveryEntryPage));
    expect(html).toContain('href="/recover/qr"');
    expect(html).toContain("リカバリー用のQRから復元する");
    expect(html).toContain("管理者に連絡する");
  });
});
