/** sidecar 応答と redirect の信頼境界テスト。 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    faceSidecarUrl: "http://face-sidecar.test",
    faceSidecarTimeoutMs: 1_000,
  },
}));

const { extractFaceEmbedding } = await import("../../src/identity/face-sidecar-client.js");

afterEach(() => { vi.unstubAllGlobals(); });

describe("extractFaceEmbedding", () => {
  it("redirect を拒否し、float32[512] だけを受理する", async () => {
    const embeddingBytes = Buffer.alloc(512 * Float32Array.BYTES_PER_ELEMENT);
    const view = new DataView(
      embeddingBytes.buffer,
      embeddingBytes.byteOffset,
      embeddingBytes.byteLength,
    );
    for (let i = 0; i < 512; i += 1) view.setFloat32(i * 4, 0.1, true);
    const embedding = embeddingBytes.toString("base64");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      modelId: "model-v1",
      faces: [{ embedding, quality: { pass: true, score: 0.9 } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractFaceEmbedding(Buffer.from("jpeg"), "image/jpeg");
    expect(result.embedding).toHaveLength(2048);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    result.embedding.fill(0);
  });

  it("長さの違う embedding は保存境界へ渡さない", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      modelId: "model-v1",
      faces: [{
        embedding: Buffer.alloc(16).toString("base64"),
        quality: { pass: true, score: 0.9 },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(extractFaceEmbedding(Buffer.from("jpeg"), "image/jpeg"))
      .rejects.toMatchObject({ statusCode: 503 });
  });
});
