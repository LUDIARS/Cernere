/** Operation / hq-config / vault / bundle grant UI regressions. @implements SPEC-WORKLOAD-AUTHORITY */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { WorkloadAuthorityPage } from "../../../frontend/src/pages/admin/WorkloadAuthorityPage";
import { buildGrantPayload, parseVaultKeys, type GrantFormValues } from "../../../frontend/src/pages/admin/workload/grant-input";

const mocks = vi.hoisted(() => ({
  send: vi.fn(), confirm: vi.fn(() => true),
  auth: { user: { id: "admin-one", role: "admin" }, wsConnected: true },
}));
vi.mock("../../../frontend/src/contexts/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../../../frontend/src/lib/ws-client", () => ({ wsClient: { get connected() { return mocks.auth.wsConnected; }, sendCommand: mocks.send } }));
vi.mock("react-router-dom", () => ({ Navigate: () => null }));

const base: GrantFormValues = {
  kind: "operation", subject: "hq/excubitor", audience: "aws/excubitor", verb: "restart", code: "excubitor", repository: "", keys: "",
};
const manyKeys = (count: number) => Array.from({ length: count }, (_, i) => `KEY_${i}`).join("\n");

describe("buildGrantPayload", () => {
  it.each([
    [{ kind: "operation", verb: "deploy", code: "excubitor" }, { action: "operation:deploy", resource: "service:excubitor" }],
    [{ kind: "hq-config", code: "ignored" }, { action: "hq-config", resource: "service:concordia" }],
    [{ kind: "bundle", repository: "LUDIARS/Cernere" }, { action: "bundle", resource: "repository:LUDIARS/Cernere" }],
  ] as const)("fixes the resource shape per action (%o)", (input, expected) => {
    const result = buildGrantPayload({ ...base, ...input });
    expect(result).toEqual({ ok: true, payload: { subject: base.subject, audience: base.audience, ...expected } });
  });
  it("sends keys only for vault", () => {
    const operation = buildGrantPayload({ ...base, keys: "KEY_A" });
    expect(operation.ok && "keys" in operation.payload).toBe(false);
    expect(buildGrantPayload({ ...base, kind: "vault", code: "concordia", keys: "KEY_B\r\nKEY_A\n" })).toEqual({ ok: true, payload: {
      subject: base.subject, audience: base.audience, action: "vault", resource: "service:concordia", keys: ["KEY_B", "KEY_A"],
    } });
  });
  it.each([
    { code: "*" }, { code: "excubitor:extra" }, { code: "a/b" }, { code: " excubitor" }, { code: "exc ubitor" }, { code: "" },
    { kind: "vault", code: "service:concordia", keys: "KEY_A" },
    { kind: "bundle", repository: "LUDIARS/*" }, { kind: "bundle", repository: "LUDIARS/Cernere/extra" },
    { kind: "bundle", repository: "LUDIARS" }, { kind: "bundle", repository: "LUDIARS/ Cernere" },
    { verb: "spawn" }, { kind: "ai-spawn" }, { subject: "excubitor" }, { audience: "AWS/excubitor" }, { audience: "" },
  ] as unknown as Partial<GrantFormValues>[])("rejects invalid input %o", input => {
    expect(buildGrantPayload({ ...base, ...input } as GrantFormValues).ok).toBe(false);
  });
  it.each(["", "\n", "KEY_A\nKEY_A", "KEY *", "*", "1KEY", "KEY-A", " KEY_A", `A${"B".repeat(128)}`, manyKeys(501)])(
    "rejects vault keys %j", keys => {
      expect(parseVaultKeys(keys).ok).toBe(false);
      expect(buildGrantPayload({ ...base, kind: "vault", keys }).ok).toBe(false);
    });
  it("accepts up to 500 vault keys", () => {
    expect(parseVaultKeys(manyKeys(500))).toMatchObject({ ok: true });
  });
});

describe("ServiceGrantForm", () => {
  let view: ReactTestRenderer;
  beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers();
    mocks.auth.user = { id: "admin-one", role: "admin" }; mocks.auth.wsConnected = true;
    mocks.send.mockResolvedValue({ id: "grant-result" });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { confirm: mocks.confirm });
  });
  afterEach(async () => {
    if (view) await act(() => view.unmount());
    vi.unstubAllGlobals(); vi.useRealTimers();
  });
  const render = () => act(() => { view = create(createElement(WorkloadAuthorityPage)); });
  // Forms: 0 registration, 1 monitor, 2 service grant, 3 revocation.
  const form = () => view.root.findAllByType("form")[2];
  const inputs = () => form().findAllByType("input");
  const selects = () => form().findAllByType("select");
  const submit = () => form().props.onSubmit({ preventDefault() {} });
  async function fill(kind: string, code: string, keys?: string) {
    await act(() => selects()[0].props.onChange({ target: { value: kind } }));
    await act(() => {
      inputs()[0].props.onChange({ target: { value: "hq/excubitor" } });
      inputs()[1].props.onChange({ target: { value: "aws/excubitor" } });
      inputs()[2].props.onChange({ target: { value: code } });
    });
    if (keys !== undefined) await act(() => form().findByType("textarea").props.onChange({ target: { value: keys } }));
  }

  it("is hidden from general users", async () => {
    mocks.auth.user.role = "general";
    await render();
    expect(view.root.findAllByType("form")).toHaveLength(0);
  });

  it("offers only fixed actions and sends a vault grant with exact keys after confirmation", async () => {
    await render();
    expect(selects()[0].findAllByType("option").map(o => o.props.value)).toEqual(["operation", "hq-config", "vault", "bundle"]);
    expect(selects()[1].findAllByType("option").map(o => o.props.value)).toEqual(
      ["update", "restart", "deploy", "reflect", "start", "stop", "bootstrap", "data-export", "data-import"]);
    await fill("vault", "concordia", "CONCORDIA_TOKEN\nDISCORD_TOKEN");
    await act(() => submit());
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith("workload_authority", "grant", {
      subject: "hq/excubitor", audience: "aws/excubitor", action: "vault", resource: "service:concordia",
      keys: ["CONCORDIA_TOKEN", "DISCORD_TOKEN"],
    });
  });

  it("refuses invalid code or keys before confirmation or transmission", async () => {
    await render();
    await fill("operation", "service:*"); await act(() => submit());
    await fill("vault", "concordia", "KEY_A\nKEY_A"); await act(() => submit());
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(form().findByProps({ role: "alert" }).children.join("")).toContain("重複");
  });

  it("does not resend after an uncertain outcome", async () => {
    mocks.send.mockReturnValue(new Promise(() => {}));
    await render(); await fill("operation", "excubitor");
    await act(() => { submit(); submit(); });
    expect(mocks.send).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(view.root.findAllByProps({ role: "alert" }).map(n => n.children.join("")).join("")).toContain("再送せず");
    await act(() => submit());
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it("does not resend after a transport error", async () => {
    mocks.send.mockRejectedValue(new Error("transport detail"));
    await render(); await fill("operation", "excubitor");
    await act(() => submit()); await act(() => submit());
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(JSON.stringify(view.toJSON())).not.toContain("transport detail");
  });
});
