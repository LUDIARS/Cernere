import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
const mocks = vi.hoisted(() => ({ pkce: vi.fn() }));
vi.mock("../../../packages/composite/src/ui/pkce.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../packages/composite/src/ui/pkce.js")>(), createCompositePkce: mocks.pkce,
}));
import { CompositePasskeyPopup } from "../../../packages/composite/src/ui/CompositePasskeyPopup.js";
let view: ReactTestRenderer | undefined;
const pkce = { codeVerifier: "v".repeat(43), codeChallenge: "c".repeat(43), state: "s".repeat(43) };
beforeEach(() => { mocks.pkce.mockReset(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { if (view) await act(() => view!.unmount()); view = undefined; vi.unstubAllGlobals(); });
function browser() {
  let listener: ((event: object) => void) | undefined;
  const popup = { closed: false, close: vi.fn(() => { popup.closed = true; }), focus: vi.fn(), location: { replace: vi.fn() } };
  const open = vi.fn(() => popup);
  const clearInterval = vi.fn(); const clearTimeout = vi.fn();
  vi.stubGlobal("window", { open, location: { href: "https://glab.example/login", origin: "https://glab.example" },
    addEventListener: (_event: string, handler: typeof listener) => { listener = handler; }, removeEventListener: vi.fn(),
    setInterval: vi.fn(() => 1), setTimeout: vi.fn(() => 2), clearInterval, clearTimeout,
    sessionStorage: { getItem: () => null }, history: { replaceState: vi.fn() } });
  return { popup, open, clearInterval, clearTimeout, receive: (state = pkce.state) => listener!({ origin: "https://cr.example", source: popup, data: { type: "cernere:auth", authCode: "code", state } }) };
}
describe("Composite popup lifetime", () => {
  it("blocks rapid clicks before PKCE completes and closes a pending popup on unmount", async () => {
    let complete: ((value: typeof pkce) => void) | undefined;
    mocks.pkce.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const ui = browser();
    await act(() => { view = create(createElement(CompositePasskeyPopup, { cernereUrl: "https://cr.example", clientId: "glab", navigationMode: "popup", onAuthCode: vi.fn() })); });
    const click = view!.root.findByType("button").props.onClick as () => Promise<void>;
    let pending: Promise<void>;
    await act(() => { pending = click(); void click(); });
    expect(ui.open).toHaveBeenCalledOnce();
    await act(() => view!.unmount()); view = undefined;
    expect(ui.popup.closed).toBe(true);
    complete!(pkce); await pending!;
    expect(ui.popup.location.replace).not.toHaveBeenCalled();
  });
  it("checks state and remains busy until backend exchange finishes", async () => {
    mocks.pkce.mockResolvedValue(pkce);
    let finish: (() => void) | undefined;
    const onAuthCode = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const ui = browser();
    await act(() => { view = create(createElement(CompositePasskeyPopup, { cernereUrl: "https://cr.example", clientId: "glab", navigationMode: "popup", onAuthCode })); });
    await act(async () => { await view!.root.findByType("button").props.onClick(); });
    await act(() => ui.receive("wrong-state")); expect(onAuthCode).not.toHaveBeenCalled();
    await act(() => ui.receive());
    expect(onAuthCode).toHaveBeenCalledExactlyOnceWith("code", pkce.codeVerifier);
    expect(view!.root.findByType("button").props.disabled).toBe(true);
    await act(async () => { await view!.root.findByType("button").props.onClick(); });
    expect(ui.open).toHaveBeenCalledOnce();
    expect(ui.clearInterval).toHaveBeenCalled(); expect(ui.clearTimeout).toHaveBeenCalled();
    await act(() => finish!()); expect(view!.root.findByType("button").props.disabled).toBe(false);
  });
});
