import { afterEach, describe, expect, it, vi } from "vitest";
import { CompositeAuthHandoff } from "../../../frontend/src/lib/composite-auth-handoff";

afterEach(() => vi.unstubAllGlobals());
describe("embedded handoff", () => {
  it.each([true, false])("only sends to an allowed parent: %s", allowed => {
    const parent = { postMessage: vi.fn() };
    const close = vi.fn();
    vi.stubGlobal("window", { parent, opener: null, close });
    const onError = vi.fn();
    const handoff = new CompositeAuthHandoff({ self: false, origin: "https://glab.example", redirectUri: null,
      redirectParam: null, exchange: vi.fn(), onError });
    handoff.setAllowedOrigins(allowed ? ["https://glab.example"] : []);
    handoff.deliver("one-time-code");
    expect(parent.postMessage).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) expect(parent.postMessage).toHaveBeenCalledWith({ type: "cernere:auth", authCode: "one-time-code" }, "https://glab.example");
    expect(close).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(allowed ? 0 : 1);
  });
});
