import { describe, expect, it, vi } from "vitest";
import {
  addConnection,
  closeConnectionsBeforeGeneration,
  getProjectConnections,
  removeConnection,
} from "../../src/ws/project-registry.js";

describe("project registry credential generations", () => {
  it("closes only connections from an older credential generation", () => {
    const projectKey = `registry-test-${crypto.randomUUID()}`;
    const oldClose = vi.fn();
    const currentClose = vi.fn();
    addConnection(projectKey, "old", "client", 4, oldClose);
    addConnection(projectKey, "current", "client", 5, currentClose);

    closeConnectionsBeforeGeneration(projectKey, 5);

    expect(oldClose).toHaveBeenCalledOnce();
    expect(currentClose).not.toHaveBeenCalled();
    expect(getProjectConnections(projectKey)).toEqual(expect.arrayContaining([
      expect.objectContaining({ connectionId: "old", credentialGeneration: 4 }),
      expect.objectContaining({ connectionId: "current", credentialGeneration: 5 }),
    ]));
    expect(getProjectConnections(projectKey)[0]).not.toHaveProperty("close");

    removeConnection(projectKey, "old");
    removeConnection(projectKey, "current");
  });
});
