import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createCompositePkce, compositeLoginUrl, type CompositePkce } from "./pkce.js";

export interface CompositeLoginFrameProps {
  cernereUrl: string;
  clientId: string;
  onAuthCode: (code: string, codeVerifier: string) => void | Promise<void>;
  onError?: (error: Error) => void;
  style?: CSSProperties;
}

/** The hosted card stays inside the service; WebAuthn retains the Cernere RP origin.
 * @implements SPEC-EMBEDDED-COMPOSITE-001
 * @implements SPEC-COMPOSITE-PROJECT-PKCE
 */
export function CompositeLoginFrame({ cernereUrl, clientId, onAuthCode, onError, style }: CompositeLoginFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const completedSource = useRef<string | null>(null);
  const [request, setRequest] = useState<(CompositePkce & { source: string; expectedOrigin: string }) | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRequest(null);
    void createCompositePkce().then(pkce => {
      const url = compositeLoginUrl(cernereUrl, { ...pkce, clientId });
      url.searchParams.set("origin", window.location.origin);
      url.searchParams.set("embedded", "1");
      if (!cancelled) setRequest({ ...pkce, source: url.toString(), expectedOrigin: url.origin });
    }).catch((error: unknown) => { if (!cancelled) onError?.(error instanceof Error ? error : new Error("ログインを開始できませんでした")); });
    return () => { cancelled = true; };
  }, [cernereUrl, clientId]);
  useEffect(() => {
    if (!request) return;
    const { source, expectedOrigin } = request;
    /** @implements SPEC-EMBEDDED-COMPOSITE-001 */
    /** @implements SPEC-COMPOSITE-PROJECT-PKCE */
    const receive = (event: MessageEvent<unknown>) => {
      if (completedSource.current === source || event.origin !== expectedOrigin || event.source !== frame.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object" || !("type" in data) || data.type !== "cernere:auth"
        || !("authCode" in data) || typeof data.authCode !== "string" || !data.authCode
        || !("state" in data) || data.state !== request.state) return;
      completedSource.current = source;
      void Promise.resolve().then(() => onAuthCode(data.authCode as string, request.codeVerifier)).catch((error: unknown) => {
        onError?.(error instanceof Error ? error : new Error("ログインを完了できませんでした"));
      });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [request, onAuthCode, onError]);
  if (!request) return null;
  return <iframe ref={frame} src={request.source} title="Cernere ログイン"
    allow="publickey-credentials-get; publickey-credentials-create; camera"
    sandbox="allow-scripts allow-same-origin allow-forms"
    style={{ width: "100%", height: "min(800px, 90vh)", minHeight: 520, border: 0, ...style }} />;
}
