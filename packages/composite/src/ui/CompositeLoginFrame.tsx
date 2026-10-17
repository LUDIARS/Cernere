import { useEffect, useRef, type CSSProperties } from "react";

export interface CompositeLoginFrameProps {
  cernereUrl: string;
  onAuthCode: (code: string) => void | Promise<void>;
  onError?: (error: Error) => void;
  style?: CSSProperties;
}

/** The hosted card stays inside the service; WebAuthn retains the Cernere RP origin.
 * @implements SPEC-EMBEDDED-COMPOSITE-001
 */
export function CompositeLoginFrame({ cernereUrl, onAuthCode, onError, style }: CompositeLoginFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const completedSource = useRef<string | null>(null);
  const url = new URL("/composite/login", cernereUrl);
  url.searchParams.set("origin", window.location.origin);
  url.searchParams.set("embedded", "1");
  const source = url.toString();
  const expectedOrigin = url.origin;
  useEffect(() => {
    /** @implements SPEC-EMBEDDED-COMPOSITE-001 */
    const receive = (event: MessageEvent<unknown>) => {
      if (completedSource.current === source || event.origin !== expectedOrigin || event.source !== frame.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object" || !("type" in data) || data.type !== "cernere:auth"
        || !("authCode" in data) || typeof data.authCode !== "string" || !data.authCode) return;
      completedSource.current = source;
      void Promise.resolve().then(() => onAuthCode(data.authCode as string)).catch((error: unknown) => {
        onError?.(error instanceof Error ? error : new Error("ログインを完了できませんでした"));
      });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [source, expectedOrigin, onAuthCode, onError]);
  return <iframe ref={frame} src={source} title="Cernere ログイン"
    allow="publickey-credentials-get; publickey-credentials-create; camera"
    sandbox="allow-scripts allow-same-origin allow-forms"
    style={{ width: "100%", height: "min(800px, 90vh)", minHeight: 520, border: 0, ...style }} />;
}
