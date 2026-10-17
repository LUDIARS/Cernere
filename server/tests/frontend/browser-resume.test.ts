import { describe, expect, it, vi } from "vitest";
import { installBrowserResumeReload } from "../../../packages/composite/src/ui/browser-resume";

function setup() {
  const win = Object.assign(new EventTarget(), { navigator: { onLine: true } });
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  let clock = 0;
  const reload = vi.fn();
  const canReload = vi.fn(() => true);
  const isConnectionStale = vi.fn(() => false);
  const cleanup = installBrowserResumeReload({
    window: win as unknown as Window, document: doc as unknown as Document,
    now: () => clock, reload, canReload, isConnectionStale,
  });
  const visibility = (state: string) => {
    doc.visibilityState = state;
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  const show = (persisted: boolean) => win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));
  return { win, doc, reload, canReload, isConnectionStale, cleanup, visibility, show,
    advance: (ms: number) => { clock += ms; } };
}

describe("retained browser document recovery", () => {
  it("does not reload an ordinary load or a brief healthy tab switch", () => {
    const h = setup(); h.show(false); h.visibility("hidden"); h.advance(1000); h.visibility("visible");
    expect(h.reload).not.toHaveBeenCalled(); h.cleanup();
  });
  it("reloads a bfcache restoration once despite overlapping events", () => {
    const h = setup(); h.visibility("hidden"); h.show(true); h.visibility("visible"); h.show(true);
    expect(h.reload).toHaveBeenCalledTimes(1); h.cleanup();
  });
  it("reloads a page returning after the hidden deadline even if its socket looks open", () => {
    const h = setup(); h.visibility("hidden"); h.advance(60_000); h.visibility("visible");
    expect(h.reload).toHaveBeenCalledTimes(1); h.cleanup();
  });
  it("recovers a closed connection after a short absence", () => {
    const h = setup(); h.visibility("hidden"); h.isConnectionStale.mockReturnValue(true); h.visibility("visible");
    expect(h.reload).toHaveBeenCalledTimes(1); h.cleanup();
  });
  it("waits for connectivity and visibility rather than reloading offline", () => {
    const h = setup(); h.win.navigator.onLine = false; h.show(true);
    expect(h.reload).not.toHaveBeenCalled(); h.visibility("hidden");
    h.win.navigator.onLine = true; h.win.dispatchEvent(new Event("online"));
    expect(h.reload).not.toHaveBeenCalled(); h.visibility("visible");
    expect(h.reload).toHaveBeenCalledTimes(1); h.cleanup();
  });
  it("does not interrupt a native authentication ceremony or queue its reload", () => {
    const h = setup(); h.canReload.mockReturnValue(false); h.visibility("hidden"); h.advance(120_000);
    h.visibility("visible"); h.canReload.mockReturnValue(true); h.win.dispatchEvent(new Event("online"));
    expect(h.reload).not.toHaveBeenCalled(); h.cleanup();
  });
  it("uses pagehide timing when visibilitychange is missing", () => {
    const h = setup(); h.win.dispatchEvent(new Event("pagehide")); h.advance(60_000); h.show(false);
    expect(h.reload).toHaveBeenCalledTimes(1); h.cleanup();
  });
  it("removes all listeners on disposal", () => {
    const h = setup(); h.cleanup(); h.show(true); h.visibility("hidden"); h.advance(60_000); h.visibility("visible");
    expect(h.reload).not.toHaveBeenCalled();
  });
});
