/** Owns the authenticated /auth connection; closing immediately disables service requests. */
export class NativeConnection {
  private socket?: WebSocket;
  private ready = false;
  get connected(): boolean { return this.ready && this.socket?.readyState === WebSocket.OPEN; }
  close(): void {
    this.ready = false;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }
  async connect(origin: string, token: string): Promise<void> {
    this.close();
    const url = new URL("/auth", origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    // Credentials are carried in the subprotocol header, never in a logged URL.
    const socket = new WebSocket(url, ["bearer", token]);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail(), 10_000);
      const fail = (): void => {
        clearTimeout(timer);
        if (this.socket === socket) this.close();
        if (!settled) { settled = true; reject(new Error("Cernere connection unavailable")); }
      };
      socket.addEventListener("error", fail);
      socket.addEventListener("close", fail);
      socket.addEventListener("message", event => {
        if (this.socket !== socket) return;
        try {
          if (typeof event.data !== "string" || event.data.length > 1_048_576) throw new Error("Invalid frame");
          const value = JSON.parse(event.data) as Record<string, unknown>;
          if (value.type === "ping") socket.send(JSON.stringify({ type: "pong", ts: value.ts }));
          else if (value.type === "connected" && typeof value.session_id === "string") {
            this.ready = true;
            clearTimeout(timer);
            if (!settled) { settled = true; resolve(); }
          } else if (value.type === "error" || value.type === "session_expired") fail();
        } catch { fail(); }
      });
    });
  }
}
