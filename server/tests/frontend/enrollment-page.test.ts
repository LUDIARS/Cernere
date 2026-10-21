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
  vi.stubGlobal("window", { location: { href: "https://cr.example/passkeys/register?return=%2Fprofile", search: "?return=%2Fprofile", origin: "https://cr.example", hash: "", assign: mocks.assign }, setInterval, clearInterval });
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
  expect(button().children).toContain("この端末に保存して連携する");
  await act(async () => { button().props.onClick(); expect(mocks.save).toHaveBeenCalledOnce(); });
  expect(mocks.assign).toHaveBeenCalledWith(expect.stringContaining("federated=1"));
});