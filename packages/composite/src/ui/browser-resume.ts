/** Recovery policy for a retained browser document. Install once per application. */
export interface BrowserResumeOptions {
  canReload: () => boolean;
  isConnectionStale: () => boolean;
  reload: () => void;
  window: Window;
  document: Document;
  now?: () => number;
  maxHiddenMs?: number;
}

/** Reload only after a resume signal, never simply because a connection failed. */
export function installBrowserResumeReload(options: BrowserResumeOptions): () => void {
  const { window: win, document: doc } = options;
  const now = options.now ?? Date.now;
  const maxHiddenMs = options.maxHiddenMs ?? 60_000;
  let hiddenAt: number | null = doc.visibilityState === "hidden" ? now() : null;
  let pending = false;
  let reloading = false;

  const recover = (): void => {
    if (!pending || reloading || doc.visibilityState !== "visible" || !win.navigator.onLine) return;
    // An auth ceremony may temporarily hide the page. Do not interrupt it later
    // with a reload queued by that same ceremony.
    if (!options.canReload()) { pending = false; return; }
    reloading = true;
    options.reload();
  };
  const resume = (restored: boolean): void => {
    if (doc.visibilityState !== "visible") {
      pending ||= restored;
      return;
    }
    const wasHidden = hiddenAt !== null;
    const expired = hiddenAt !== null && now() - hiddenAt >= maxHiddenMs;
    hiddenAt = null;
    pending ||= restored || expired || (wasHidden && options.isConnectionStale());
    recover();
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === "hidden") hiddenAt ??= now();
    else resume(false);
  };
  const onPageHide = (): void => { hiddenAt ??= now(); };
  const onPageShow = (event: PageTransitionEvent): void => resume(event.persisted);
  win.addEventListener("pageshow", onPageShow);
  win.addEventListener("pagehide", onPageHide);
  win.addEventListener("online", recover);
  doc.addEventListener("visibilitychange", onVisibility);
  return () => {
    win.removeEventListener("pageshow", onPageShow);
    win.removeEventListener("pagehide", onPageHide);
    win.removeEventListener("online", recover);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
