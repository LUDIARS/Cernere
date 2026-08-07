import { describe, expect, it } from "vitest";
import { canUnlinkProvider, type LoginMethodState } from "../../src/auth/login-methods.js";

const none: LoginMethodState = {
  hasPassword: false,
  passkeyCount: 0,
  hasGitHubAuth: false,
  hasGoogleAuth: false,
};

describe("canUnlinkProvider", () => {
  it("refuses to remove the only OAuth login when nothing else remains", () => {
    expect(canUnlinkProvider("github", { ...none, hasGitHubAuth: true })).toBe(false);
    expect(canUnlinkProvider("google", { ...none, hasGoogleAuth: true })).toBe(false);
  });

  it("allows removal when a password remains", () => {
    expect(canUnlinkProvider("github", { ...none, hasGitHubAuth: true, hasPassword: true })).toBe(true);
  });

  // passkey を集合から落とすと、 passkey だけのユーザが OAuth を外せなくなる。
  it("allows removal when a passkey remains", () => {
    expect(canUnlinkProvider("github", { ...none, hasGitHubAuth: true, passkeyCount: 1 })).toBe(true);
  });

  it("allows removal when the other OAuth provider remains", () => {
    expect(canUnlinkProvider("github", { ...none, hasGitHubAuth: true, hasGoogleAuth: true })).toBe(true);
    expect(canUnlinkProvider("google", { ...none, hasGitHubAuth: true, hasGoogleAuth: true })).toBe(true);
  });

  it("does not count the provider being removed as the survivor", () => {
    expect(canUnlinkProvider("github", { ...none, hasGitHubAuth: true, hasGoogleAuth: false })).toBe(false);
    expect(canUnlinkProvider("google", { ...none, hasGoogleAuth: true, hasGitHubAuth: false })).toBe(false);
  });

  // Discord は link 専用でログインには使えないので、 常に解除できる。
  it("always allows unlinking Discord, even with no other method", () => {
    expect(canUnlinkProvider("discord", none)).toBe(true);
  });
});
