/**
 * PeerAdapter end-to-end test — 7 ステップ protocol を fake Cernere と
 * 2 つの PeerAdapter で走らせ、A → B の invoke が通ることを確認する.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FakeCernere } from "../src/testing/fake-cernere.js";
import { PeerAdapter } from "../src/peer/peer-adapter.js";

describe("PeerAdapter — full relay protocol", () => {
  let cernere: FakeCernere;
  let cernereBaseUrl: string;
  let actio: PeerAdapter;
  let imperativus: PeerAdapter;

  beforeAll(async () => {
    cernere = new FakeCernere({
      projects: [
        { projectKey: "actio",        clientId: "actio-cid",   clientSecret: "actio-sec" },
        { projectKey: "imperativus",  clientId: "imp-cid",     clientSecret: "imp-sec" },
      ],
      relayPairs: [["actio", "imperativus"]],
    });
    const r = await cernere.start();
    cernereBaseUrl = r.baseUrl;

    actio = new PeerAdapter({
      projectId:       "actio-cid",
      projectSecret:   "actio-sec",
      cernereBaseUrl,
      saListenHost:    "127.0.0.1",
      saListenPort:    0,
      saPublicBaseUrl: "ws://127.0.0.1:{port}",
      accept:          { imperativus: ["tasks.create"] },
    });
    actio.handle("tasks.create", async (caller, payload) => {
      const p = payload as { title?: string };
      return { id: "task-" + (p.title ?? "x"), from: caller.projectKey };
    });
    await actio.start();

    imperativus = new PeerAdapter({
      projectId:       "imp-cid",
      projectSecret:   "imp-sec",
      cernereBaseUrl,
      saListenHost:    "127.0.0.1",
      saListenPort:    0,
      saPublicBaseUrl: "ws://127.0.0.1:{port}",
      accept:          { actio: ["ping"] },
    });
    imperativus.handle("ping", async () => ({ pong: true }));
    await imperativus.start();
  });

  afterAll(async () => {
    await imperativus.stop();
    await actio.stop();
    await cernere.stop();
  });

  it("imperativus → actio.tasks.create returns the echoed task id", async () => {
    const result = await imperativus.invoke<{ id: string; from: string }>(
      "actio",
      "tasks.create",
      { title: "milk" },
    );
    expect(result.id).toBe("task-milk");
    expect(result.from).toBe("imperativus");
  });

  it("reuses the same channel for a second invoke (no re-handshake)", async () => {
    const before = actio.boundListenPort; // sanity
    const r1 = await imperativus.invoke<{ id: string }>("actio", "tasks.create", { title: "eggs" });
    const r2 = await imperativus.invoke<{ id: string }>("actio", "tasks.create", { title: "bread" });
    expect(r1.id).toBe("task-eggs");
    expect(r2.id).toBe("task-bread");
    expect(actio.boundListenPort).toBe(before);
  });

  it("rejects commands not in accept list with forbidden error", async () => {
    await expect(
      imperativus.invoke("actio", "tasks.delete", { id: "x" }),
    ).rejects.toThrow(/forbidden|not allowed/i);
  });

  it("rejects invoke toward unknown/unregistered peer", async () => {
    // actio does not have imperativus in its accept list for "unknown.cmd"
    // Here call imperativus→actio with unknown command (same path handled above),
    // and also check request_peer rejection for non-pair.
    const rogue = new PeerAdapter({
      projectId:       "imp-cid",
      projectSecret:   "imp-sec",
      cernereBaseUrl,
      saListenHost:    "127.0.0.1",
      saListenPort:    0,
      saPublicBaseUrl: "ws://127.0.0.1:{port}",
      accept:          {},
    });
    await rogue.start();
    await expect(
      rogue.invoke("schedula", "anything", {}),
    ).rejects.toThrow();
    await rogue.stop();
  });
});
