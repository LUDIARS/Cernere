import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  bodyFraming,
  forwardHeaders,
  normalizeClientIpHeader,
  proxyHttp,
} from "../../../frontend/serve/backend-proxy.mjs";

describe("frontend proxy body framing", () => {
  it("rejects bodies on methods that must not carry one", () => {
    for (const method of ["GET", "HEAD", "DELETE", "OPTIONS", "get"]) {
      expect(bodyFraming(method, { "transfer-encoding": "chunked" }).reject).toBe(true);
      expect(bodyFraming(method, { "content-length": "5" }).reject).toBe(true);
      expect(bodyFraming(method, {}).reject).toBe(false);
      expect(bodyFraming(method, { "content-length": "0" }).reject).toBe(false);
    }
  });

  it("re-frames chunked bodies explicitly and keeps Content-Length otherwise", () => {
    expect(bodyFraming("POST", { "transfer-encoding": "chunked" })).toEqual({ reject: false, headers: { "transfer-encoding": "chunked" }, dropLength: true });
    expect(bodyFraming("POST", { "content-length": "12" })).toEqual({ reject: false, headers: {}, dropLength: false });
  });
});

describe("frontend proxy CF-Connecting-IP", () => {
  it("keeps one valid IP and drops anything else", () => {
    expect(normalizeClientIpHeader(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(normalizeClientIpHeader("2001:db8::1")).toBe("2001:db8::1");
    for (const bad of [undefined, "", "evil", "203.0.113.7, 198.51.100.1", ["203.0.113.7", "198.51.100.1"]]) {
      expect(normalizeClientIpHeader(bad)).toBeUndefined();
    }
    const backend = new URL("http://127.0.0.1:8086");
    expect(forwardHeaders({ host: "x", "cf-connecting-ip": "a, b" }, backend)).toEqual({ host: "127.0.0.1:8086" });
  });
});

// 実ソケットで、中継が backend に送るバイト列を確かめる (request desync の回帰)。
describe("frontend proxy against a raw backend", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { while (closers.length) await closers.pop()!(); });

  /** 受け取った生のバイト列を貯め、要求行の数を数えるだけの backend。 */
  async function rawBackend() {
    const received: string[] = [];
    const server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (d) => {
        buf += d.toString("latin1");
        // 終端 (空チャンク or 本文なし) まで来たら 1 回だけ応答して閉じる。
        if (buf.includes("\r\n0\r\n\r\n") || (buf.includes("\r\n\r\n") && !/transfer-encoding/i.test(buf))) {
          received.push(buf);
          socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => server.close(() => r())));
    return { url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), received };
  }

  async function proxyTo(backend: URL) {
    const server = http.createServer((req, res) => proxyHttp(req, res, backend, req.url ?? "/"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => server.close(() => r())));
    return (server.address() as AddressInfo).port;
  }

  function rawRequest(port: number, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // 書き込み側を閉じると Node の HTTP サーバは応答前に接続を閉じるので、閉じずに connection: close で終わるのを待つ。
      const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
      let out = "";
      socket.on("data", (d) => { out += d.toString(); });
      socket.on("end", () => resolve(out));
      socket.on("error", reject);
    });
  }

  it("refuses a chunked GET instead of leaking the body as a second request", async () => {
    const backend = await rawBackend();
    const port = await proxyTo(backend.url);
    const smuggled = "GET /oidc/token HTTP/1.1\r\nhost: x\r\ncf-connecting-ip: 198.51.100.9\r\n\r\n";
    const body = smuggled.length.toString(16) + "\r\n" + smuggled + "\r\n0\r\n\r\n";
    const response = await rawRequest(port, `GET /api/auth/me HTTP/1.1\r\nhost: cr.example\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n${body}`);
    expect(response.startsWith("HTTP/1.1 400")).toBe(true);
    expect(backend.received).toEqual([]);
  });

  it("forwards a chunked POST as one chunked request", async () => {
    const backend = await rawBackend();
    const port = await proxyTo(backend.url);
    const response = await rawRequest(port, "POST /api/auth/x HTTP/1.1\r\nhost: cr.example\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n5\r\nhello\r\n0\r\n\r\n");
    expect(response).toContain("200 OK");
    expect(backend.received).toHaveLength(1);
    const forwarded = backend.received[0];
    expect(forwarded.match(/^POST /gm)).toHaveLength(1);
    expect(forwarded).toMatch(/transfer-encoding: chunked/i);
    expect(forwarded).toContain("hello");
  });
});
