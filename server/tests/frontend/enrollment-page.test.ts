import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PasskeyEnrollmentPage } from "../../../frontend/src/pages/PasskeyEnrollmentPage";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), complete: vi.fn() }));
vi.mock("../../../frontend/src/lib/api", () => ({ auth: { preparePasskeyRegistration: mocks.prepare } }));
vi.mock("../../../frontend/src/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "user", name: "User" } }) }));
vi.mock("react-router-dom", () => ({ Link: "a", Navigate: "navigate" }));
let view: ReactTestRenderer;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockResolvedValue(mocks.complete);
  mocks.complete.mockResolvedValue({ ok: true });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { location: { search: "", origin: "https://cr.example" },
    PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => true } });
});
afterEach(async () => { if (view) await act(() => view.unmount()); vi.unstubAllGlobals(); });

it("waits for a second click after preparation and retries from preparation after cancellation", async () => {
  await act(() => { view = create(createElement(PasskeyEnrollmentPage)); });
  expect(mocks.prepare).not.toHaveBeenCalled();
  const button = () => view.root.findAllByType("button")[0];
  await act(() => button().props.onClick());
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(button().children).toContain("この端末に保存する");
  mocks.complete.mockRejectedValueOnce(new Error("cancelled"));
  await act(() => {
    button().props.onClick();
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  expect(button().children).toContain("登録を準備する");
  await act(() => button().props.onClick());
  await act(() => button().props.onClick());
  expect(JSON.stringify(view.toJSON())).toContain("この端末にパスキーを登録しました。");
});
