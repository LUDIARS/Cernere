import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompositeLoginPage } from "../../../frontend/src/pages/composite/CompositeLoginPage";
import { LoginAttempt } from "../../../frontend/src/pages/composite/LoginAttempt";
import { RecoveryEntryPage } from "../../../frontend/src/pages/RecoveryEntryPage";
import { hasLoginCookie, rememberLoginCookie } from "../../../frontend/src/lib/login-cookie";

const session = vi.hoisted(() => vi.fn(() => { throw new Error("Authentication started before login click"); }));
vi.mock("../../../frontend/src/hooks/useCompositeLoginSession", () => ({ useCompositeLoginSession: session }));
vi.mock("@ludiars/cernere-composite/ui", () => ({
  CompositeLogin: () => { throw new Error("Legacy login UI must never mount"); },
  usePasskeyLogin: () => ({ phase: "fallback", hasAttempted: true }),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("explicit Cernere login entry", () => {
  it("keeps authentication and cancellation status free of legacy login controls", () => {
    vi.stubGlobal("window", { location: { search: "" } });
    session.mockReturnValueOnce({ adapter: {}, passkeyAutoReady: true, blockedReason: "", handoffError: "", deliver: vi.fn() } as never);
    const html = renderToStaticMarkup(createElement(LoginAttempt, { self: true, choice: { crossDevice: false, enroll: true }, onBusy: vi.fn() }));
    expect(html).toContain("ログインは完了していません");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a");
  });
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
    expect(html).toContain("border-radius:var(--radius, 8px)");
    expect(html).toContain("background:var(--bg-surface, #fff)");
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
  it.each(["", "theme=dark", "CF_Authorization=opaque; analytics=1", "cernere_returning=0", "cernere_returning=", "other_cernere_returning=1"])("does not treat unrelated or invalid cookies as login history: %s", cookie => {
    vi.stubGlobal("document", { cookie });
    expect(hasLoginCookie()).toBe(false);
  });
  it("recognizes only the exact returning marker among other cookies", () => {
    vi.stubGlobal("document", { cookie: "theme=dark; cernere_returning=1; analytics=1" });
    expect(hasLoginCookie()).toBe(true);
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
