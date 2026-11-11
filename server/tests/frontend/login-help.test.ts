import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DEVICE_MENU_LABEL, DEVICE_SWITCH_HELP, LoginHelp, visibleHelpTopics } from "../../../frontend/src/pages/composite/LoginHelp";
import { NAV_GENERAL } from "../../../frontend/src/components/nav-items";

let view: ReactTestRenderer;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { if (view) await act(() => view.unmount()); vi.unstubAllGlobals(); });

const text = (node: ReactTestRenderer): string => JSON.stringify(node.toJSON());

describe("login help (QR device switching)", () => {
  it("covers every switching direction the existing QR flows support", () => {
    expect(DEVICE_SWITCH_HELP.map((t) => t.title)).toEqual([
      "PC からスマホへ", "スマホから PC へ", "PC を買い替えたとき", "スマホを買い替えたとき", "すべての端末をなくしたとき",
    ]);
    for (const topic of DEVICE_SWITCH_HELP) expect(topic.steps.length).toBeGreaterThan(0);
  });

  it("points at the menu that actually hosts device pairing", () => {
    expect(NAV_GENERAL.map((item) => item.label)).toContain(DEVICE_MENU_LABEL);
    const pairing = DEVICE_SWITCH_HELP.filter((t) => t.steps.some((s) => s.includes("別の端末を追加する")));
    expect(pairing.length).toBeGreaterThan(0);
    for (const topic of pairing) expect(topic.steps.join("")).toContain(DEVICE_MENU_LABEL);
  });

  it("omits steps that need the phone-login button where that button is not shown", async () => {
    expect(visibleHelpTopics(true)).toEqual(DEVICE_SWITCH_HELP);
    const returning = visibleHelpTopics(false);
    expect(returning.map((t) => t.title)).toEqual(["PC からスマホへ", "スマホを買い替えたとき", "すべての端末をなくしたとき"]);
    expect(returning.some((t) => t.steps.join("").includes("スマホでログイン"))).toBe(false);
    await act(() => { view = create(createElement(LoginHelp, { phoneLoginAvailable: false })); });
    expect(text(view)).not.toContain("スマホでログイン");
  });

  it("renders the steps inside the collapsed help with the QR safety warning", async () => {
    await act(() => { view = create(createElement(LoginHelp)); });
    const out = text(view);
    expect(view.root.findByType("details")).toBeTruthy();
    expect(out).toContain("QR は他の人に見せたり");
    expect(out).toContain("アカウントを復旧する");
    expect(view.root.findAllByType("ol")).toHaveLength(DEVICE_SWITCH_HELP.length);
  });
});
