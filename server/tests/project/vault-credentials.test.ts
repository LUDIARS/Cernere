import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveProjectCredentials, projectCredentialNames } from "../../src/project/vault-credentials.js";
import { resolveVaultEndpoint } from "../../src/project/vault-endpoint.js";
import { mergeVaultBindingNames } from "../../src/project/vault-bindings.js";

const credentials = { key: "aedilis", clientId: "dummy-client-id", clientSecret: "dummy-client-secret" };
const id = "EXCUBITOR_CERNERE_CLIENT_ID";
const secretName = "EXCUBITOR_CERNERE_CLIENT_SECRET";
const fetchMock = vi.fn<typeof fetch>();
const status = {
  bindings: { excubitor: [{ name: "SHARED_OLD", present: true }] },
  projects: [{ id: "project/one", bindings: { excubitor: [{ name: "PROJECT_OLD", present: false }] } }],
};

beforeEach(() => {
  vi.stubEnv("EXCUBITOR_URL", "http://127.0.0.1:23456");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async (_url, init) =>
    Response.json(init?.method === "GET" ? status : { ok: true }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Vault credential delivery", () => {
  it.each([undefined, "project/one"])("preserves the selected scope's bindings (%s)", async (project) => {
    await expect(saveProjectCredentials(credentials, { service: "excubitor", project })).resolves.toBeUndefined();
    const suffix = project === undefined ? "" : "?project=project%2Fone";
    const calls = fetchMock.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:23456/api/v1/vault",
      `http://127.0.0.1:23456/api/v1/vault/bindings/excubitor${suffix}`,
      `http://127.0.0.1:23456/api/v1/vault/entries/${id}${suffix}`,
      `http://127.0.0.1:23456/api/v1/vault/entries/${secretName}${suffix}`,
    ]);
    expect(JSON.parse(calls[1][1]?.body as string)).toEqual({ names: [project ? "PROJECT_OLD" : "SHARED_OLD", id, secretName] });
    expect(JSON.parse(calls[2][1]?.body as string)).toEqual({ value: credentials.clientId });
    expect(JSON.parse(calls[3][1]?.body as string)).toEqual({ value: credentials.clientSecret });
    expect(calls.every(([, init]) => init?.redirect === "error" && init.signal)).toBe(true);
  });

  it("does not replace a complete binding list", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ bindings: { excubitor: ["OLD", id, secretName].map((name) => ({ name, present: true })) }, projects: [] }));
    await saveProjectCredentials(credentials, { service: "excubitor" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/bindings/"))).toBe(false);
  });

  it.each([0, 1, 2, 3])("stops on request %s failure without leaking response contents", async (failure) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let index = 0;
    fetchMock.mockImplementation(async (_url, init) => index++ === failure
      ? new Response(`${credentials.clientId} ${credentials.clientSecret}`, { status: 403 })
      : Response.json(init?.method === "GET" ? status : { ok: true }));
    await expect(saveProjectCredentials(credentials, { service: "excubitor" })).rejects.toThrow(
      "Vault credential save failed; Cernere DB was not updated");
    expect(fetchMock).toHaveBeenCalledTimes(failure + 1);
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });

  it.each([{}, { bindings: {}, projects: [] }])("rejects malformed or unknown project scopes before PUT", async (body) => {
    fetchMock.mockResolvedValueOnce(Response.json(body));
    await expect(saveProjectCredentials(credentials, { service: "excubitor", project: "missing" })).rejects.toThrow("Vault credential save failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes network and JSON failures", async () => {
    fetchMock.mockRejectedValueOnce(new Error(credentials.clientSecret));
    await expect(saveProjectCredentials(credentials, { service: "excubitor" })).rejects.toThrow(/^Vault credential save failed; Cernere DB was not updated$/);
    fetchMock.mockResolvedValueOnce(new Response(credentials.clientSecret));
    await expect(saveProjectCredentials(credentials, { service: "excubitor" })).rejects.toThrow(/^Vault credential save failed; Cernere DB was not updated$/);
  });

  it("keeps legacy naming and permits an explicit service prefix", () => {
    expect(projectCredentialNames("aedilis")).toEqual([id, secretName]);
    expect(projectCredentialNames("EducationLab")).toEqual(["EDUCATIONLAB_CERNERE_CLIENT_ID", "EDUCATIONLAB_CERNERE_CLIENT_SECRET"]);
    expect(projectCredentialNames("aedilis", "CUSTOM")[0]).toBe("CUSTOM_CERNERE_CLIENT_ID");
    expect(() => projectCredentialNames("aedilis", "bad/prefix")).toThrow();
    expect(mergeVaultBindingNames(["A", "B"], ["B", "C"])).toEqual(["A", "B", "C"]);
  });
});

describe("Vault endpoint injection", () => {
  it("uses URL before port and never assumes a default", () => {
    expect(resolveVaultEndpoint({ EXCUBITOR_URL: "http://localhost:23456/", EXCUBITOR_PORT: "23457" })).toBe("http://localhost:23456");
    expect(resolveVaultEndpoint({ EXCUBITOR_PORT: "23457" })).toBe("http://127.0.0.1:23457");
    expect(() => resolveVaultEndpoint({})).toThrow("EXCUBITOR_URL");
  });
  it.each(["https://remote.example", "http://127.0.0.1:23456/path", "http://user:secret@localhost:23456", "http://localhost:0", "invalid-secret"])("rejects unsafe endpoint without echoing it (%s)", (url) => {
    expect(() => resolveVaultEndpoint({ EXCUBITOR_URL: url })).toThrow(/^Set EXCUBITOR_URL or EXCUBITOR_PORT to the loopback Excubitor management endpoint$/);
  });
});
