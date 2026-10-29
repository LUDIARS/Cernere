/** Enrollment UI safety regressions. @implements SPEC-WORKLOAD-AUTHORITY */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { generateKeyPairSync } from "node:crypto";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { WorkloadAuthorityPage } from "../../../frontend/src/pages/admin/WorkloadAuthorityPage";

const mocks = vi.hoisted(() => ({
  send: vi.fn(), confirm: vi.fn(() => true),
  auth: { user: { id: "admin-one", role: "admin" }, wsConnected: true },
}));
vi.mock("../../../frontend/src/contexts/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../../../frontend/src/lib/ws-client", () => ({ wsClient: { get connected() { return mocks.auth.wsConnected; }, sendCommand: mocks.send } }));
vi.mock("react-router-dom", () => ({ Navigate: () => null }));
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
async function render() { await act(() => { view = create(createElement(WorkloadAuthorityPage)); }); }
async function prepareGrant() {
  const inputs = view.root.findAllByType("input");
  await act(() => {
    inputs[1].props.onChange({ target: { value: "hq/excubitor" } });
    inputs[2].props.onChange({ target: { value: "aws/excubitor" } });
  });
}
const submitGrant = () => view.root.findAllByType("form")[1].props.onSubmit({ preventDefault() {} });

it("hides enrollment from non-admin users and refuses disconnected submissions", async () => {
  mocks.auth.user.role = "general";
  await render(); expect(view.root.findAllByType("form")).toHaveLength(0);
  mocks.auth.user.role = "admin"; mocks.auth.wsConnected = false;
  await act(() => view.update(createElement(WorkloadAuthorityPage)));
  await act(() => submitGrant());
  expect(mocks.send).not.toHaveBeenCalled();
});

it("sends only a one-way monitor grant after confirmation", async () => {
  await render(); await prepareGrant();
  await act(() => submitGrant());
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith("workload_authority", "grant", {
    subject: "hq/excubitor", audience: "aws/excubitor", action: "monitor", resource: "node:aws/excubitor",
  });
});

it("does not send when the operator cancels", async () => {
  mocks.confirm.mockReturnValueOnce(false);
  await render(); await prepareGrant(); await act(() => submitGrant());
  expect(mocks.send).not.toHaveBeenCalled();
});

it("blocks duplicate submissions and does not retry a timeout", async () => {
  mocks.send.mockReturnValue(new Promise(() => {}));
  await render(); await prepareGrant();
  await act(() => { submitGrant(); submitGrant(); });
  expect(mocks.send).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain("再送せず");
  await act(() => submitGrant()); expect(mocks.send).toHaveBeenCalledOnce();
});

it("does not expose raw errors or permit another mutation after uncertain failure", async () => {
  mocks.send.mockRejectedValue(new Error("sensitive transport detail"));
  await render(); await prepareGrant(); await act(() => submitGrant());
  expect(JSON.stringify(view.toJSON())).not.toContain("sensitive transport detail");
  await act(() => submitGrant()); expect(mocks.send).toHaveBeenCalledOnce();
});

it("rejects a private key before transmission", async () => {
  // Ephemeral fixture: never embed key material in source or log the generated value.
  const { privateKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await render();
  await act(() => view.root.findByType("textarea").props.onChange({ target: { value: privatePem } }));
  await act(() => view.root.findAllByType("form")[0].props.onSubmit({ preventDefault() {} }));
  expect(mocks.send).not.toHaveBeenCalled();
});

it("clears one-time credentials when dismissed or the account changes", async () => {
  const receipt = { id: "hq/excubitor", key_id: "key-id", client_id: "client-id", client_secret: "synthetic-ui-receipt" };
  mocks.send.mockResolvedValue(receipt);
  await render(); await prepareGrant(); await act(() => submitGrant());
  expect(JSON.stringify(view.toJSON())).toContain(receipt.client_secret);
  await act(() => view.root.findAllByType("button").find(b => b.children.includes("結果を確認して閉じる"))!.props.onClick());
  expect(JSON.stringify(view.toJSON())).not.toContain(receipt.client_secret);
  await act(() => submitGrant());
  mocks.auth.user = { id: "admin-two", role: "admin" };
  await act(() => view.update(createElement(WorkloadAuthorityPage)));
  expect(JSON.stringify(view.toJSON())).not.toContain(receipt.client_secret);
});
