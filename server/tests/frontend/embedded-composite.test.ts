import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { CompositeLoginFrame } from "../../../packages/composite/src/ui/CompositeLoginFrame";

let view: ReactTestRenderer | undefined;
afterEach(async () => { if (view) await act(() => view!.unmount()); vi.unstubAllGlobals(); });
describe("embedded Composite", () => {
  it("stays in the host and accepts only one code from its own frame and origin", async () => {
    const child = {};
    let listener: ((event: object) => void) | undefined;
    const remove = vi.fn();
    const open = vi.fn();
    const assign = vi.fn();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { location: { origin: "https://glab.example", assign }, open,
      addEventListener: (_type: string, callback: typeof listener) => { listener = callback; }, removeEventListener: remove });
    const onAuthCode = vi.fn();
    const props = { cernereUrl: "https://cr.example", onAuthCode };
    await act(() => { view = create(createElement(CompositeLoginFrame, props), { createNodeMock: () => ({ contentWindow: child }) }); });
    const frame = view!.root.findByType("iframe");
    expect(frame.props.src).toContain("origin=https%3A%2F%2Fglab.example");
    expect(frame.props.sandbox).not.toContain("allow-top-navigation");
    expect(frame.props.sandbox).not.toContain("allow-popups");
    expect(frame.props.allow).toContain("publickey-credentials-create");
    const message = { origin: "https://cr.example", source: child, data: { type: "cernere:auth", authCode: "code" } };
    await act(() => { listener!({ ...message, source: {} }); listener!({ ...message, origin: "https://evil.example" }); });
    expect(onAuthCode).not.toHaveBeenCalled();
    await act(() => listener!(message));
    const changedCallback = vi.fn();
    await act(() => view!.update(createElement(CompositeLoginFrame, { ...props, onAuthCode: changedCallback })));
    await act(() => listener!(message));
    expect(onAuthCode).toHaveBeenCalledExactlyOnceWith("code");
    expect(changedCallback).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled(); expect(assign).not.toHaveBeenCalled();
    await act(() => view!.unmount()); view = undefined;
    expect(remove).toHaveBeenCalled();
  });
});
