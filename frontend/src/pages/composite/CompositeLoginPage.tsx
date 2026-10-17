/** Cernere login keeps one entry card throughout authentication. */
import { useState } from "react";
import { LoginEntry, type LoginChoice } from "./LoginEntry";
import { LoginAttempt } from "./LoginAttempt";
import { resolveSelfRedirectTarget } from "../../lib/composite-auth-handoff";

export function CompositeLoginPage({ self = false }: { self?: boolean } = {}) {
  const [attempt, setAttempt] = useState<(LoginChoice & { id: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const params = new URLSearchParams(window.location.search);
  const embedded = window.self !== window.top;
  const returnTo = self
    ? resolveSelfRedirectTarget(params.get("redirect") ?? "/", window.location.origin)
    : window.location.pathname + window.location.search;
  const start = (choice: LoginChoice) => {
    setBusy(true);
    setAttempt(previous => ({ ...choice, id: (previous?.id ?? 0) + 1 }));
  };
  return <main style={{ minHeight: embedded ? undefined : "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: embedded ? "transparent" : "var(--bg)", padding: embedded ? 0 : "1rem", boxSizing: "border-box" }}>
    <LoginEntry returnTo={returnTo} onLogin={start} busy={busy}>
      {attempt && <LoginAttempt key={attempt.id} self={self} choice={attempt} onBusy={setBusy} />}
    </LoginEntry>
  </main>;
}
