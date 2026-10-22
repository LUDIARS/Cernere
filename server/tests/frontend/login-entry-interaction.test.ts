import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { CompositeLoginPage } from "../../../frontend/src/pages/composite/CompositeLoginPage";

const state = vi.hoisted(() => ({ phase: "running", error: "", response: null as null | ((response: { authCode: string }) => void), args: vi.fn(), deliver: vi.fn() }));
vi.mock("../../../frontend/src/hooks/useCompositeLoginSession", () => ({ useCompositeLoginSession: (args: unknown) => {
  state.args(args);
  return { adapter: {}, passkeyAutoReady: true, blockedReason: "", handoffError: state.error, deliver: state.deliver };
} }));
vi.mock("@ludiars/cernere-composite/ui", () => ({
  CompositeLogin: () => { throw new Error("Legacy screen mounted"); },
  usePasskeyLogin: (args: { onResponse: typeof state.response }) => {
    state.response = args.onResponse;
    return { phase: state.phase, hasAttempted: true };
  },
}));
let view: ReactTestRenderer;
beforeEach(() => {
  state.phase = "running"; state.error = ""; state.response = null; vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { cookie: "" });
  vi.stubGlobal("window", { location: { origin: "https://cr.example", pathname: "/login", search: "" } });
});
afterEach(async () => { if (view) await act(() => view.unmount()); vi.unstubAllGlobals(); });
const page = () => createElement(CompositeLoginPage, { self: true });
const phone = () => view.root.findAllByType("button").find(button => button.children.includes("スマホでログイン"))!;

describe("login card interactions", () => {
  it("starts only on click, has no enrollment checkbox, and retries on the same card", async () => {
    await act(() => { view = create(page()); });
    expect(state.args).not.toHaveBeenCalled();
    expect(view.root.findAllByType("input")).toHaveLength(0);
    await act(() => phone().props.onClick());
    expect(state.args).toHaveBeenLastCalledWith(expect.objectContaining({ crossDevice: true }));
    expect(phone().props.disabled).toBe(true);
    state.phase = "fallback";
    await act(() => view.update(page()));
    expect(phone().props.disabled).toBe(false);
    expect(view.root.findAllByType("input")).toHaveLength(0);
    const priorCalls = state.args.mock.calls.length;
    state.phase = "running";
    await act(() => phone().props.onClick());
    expect(state.args.mock.calls.length).toBeGreaterThan(priorCalls);
    expect(view.root.findAllByType("section")).toHaveLength(1);
    expect(view.root.findAllByType("button")).toHaveLength(2);
  });
  it("keeps login disabled through async handoff and allows retry if handoff fails", async () => {
    vi.stubGlobal("document", { cookie: "cernere_passkey_registered=1" });
    await act(() => { view = create(page()); });
    expect(view.root.findAllByType("input")).toHaveLength(0);
    expect(view.root.findAllByType("button")).toHaveLength(1);
    await act(() => view.root.findByType("button").props.onClick());
    await act(() => { state.phase = "idle"; state.response!({ authCode: "code" }); });
    expect(state.deliver).toHaveBeenCalledWith("code");
    expect(view.root.findByType("button").props.disabled).toBe(true);
    state.error = "exchange failed";
    await act(() => view.update(page()));
    expect(view.root.findByType("button").props.disabled).toBe(false);
  });
});
