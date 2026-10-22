import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PasskeyEnrollmentPage } from "../../../frontend/src/pages/PasskeyEnrollmentPage";
const mocks = vi.hoisted(() => ({ request: vi.fn(), status: vi.fn(), prepare: vi.fn(), save: vi.fn(), services: vi.fn(), assign: vi.fn() }));
vi.mock("../../../frontend/src/lib/browser-token-store", () => ({ getAccessToken: () => "phone-session" }));
vi.mock("../../../frontend/src/lib/device-kind", () => ({ isMobileDevice: () => false }));
vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64,qr" } }));
vi.mock("../../../frontend/src/components/federation/QrScanner", () => ({ QrScanner: () => null }));
vi.mock("../../../frontend/src/lib/federation-api", () => ({
  federationDevice: { createRequest: mocks.request, status: mocks.status, prepareNewDevice: mocks.prepare, myServices: mocks.services },
  readJoinToken: () => null, joinUrlKind: () => null, federationErrorMessage: (e: Error) => e.message,
}));
let view: ReactTestRenderer;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.request.mockResolvedValue({ requestId: "request", deviceSecret: "secret", code: "1234", approveUrl: "https://cr.example/approve" });
  mocks.status.mockResolvedValue({ state: "approved" });
  mocks.prepare.mockResolvedValue(mocks.save);
  mocks.save.mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { cookie: "" });
  vi.stubGlobal("window", { location: { href: "https://cr.example/passkeys/register?return=%2Fprofile", search: "?return=%2Fprofile", origin: "https://cr.example", hash: "", assign: mocks.assign }, setInterval, clearInterval });
});
it("remembers prompt dismissal without registering a passkey and can continue without creating a request", async () => {
  await act(() => { view = create(createElement(PasskeyEnrollmentPage)); });
  expect(view.root.findByType("h1").children).toContain("端末を追加する");
  await act(() => view.root.findByType("input").props.onChange({ target: { checked: true } }));
  expect(document.cookie).toContain("cernere_hide_device_enrollment=1;");
  expect(document.cookie).not.toContain("cernere_passkey_registered");
  await act(() => view.root.findAllByType("button").find(button => button.children.includes("今は追加せずに続ける"))!.props.onClick());
  expect(mocks.assign).toHaveBeenCalledWith("/profile");
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});
afterEach(async () => { if(view) await act(() => view.unmount()); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("creates a distinct PC request despite phone login, waits for approval, then saves on a separate click", async () => {
  await act(() => { view = create(createElement(PasskeyEnrollmentPage)); });
  expect(mocks.services).not.toHaveBeenCalled();
  await act(async () => { view.root.findAllByType("button")[0].props.onClick(); });
  expect(mocks.request).toHaveBeenCalledWith(true);
  expect(mocks.prepare).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  const button = () => view.root.findAllByType("button")[0];
  await act(async () => { button().props.onClick(); });
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request" }), true);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(button().children).toContain("このPCにパスキーを保存する");
  await act(async () => { button().props.onClick(); expect(mocks.save).toHaveBeenCalledOnce(); });
  expect(mocks.assign).toHaveBeenCalledWith(expect.stringContaining("federated=1"));
});
