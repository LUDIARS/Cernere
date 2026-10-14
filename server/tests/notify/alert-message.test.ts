import { describe, expect, it } from "vitest";
import { renderAlertMessage, renderVerificationMessage } from "../../src/notify/alert-message";
import { escapeDiscord } from "../../src/notify/discord-alert-sender";
import { backoffMs } from "../../src/notify/outbox-worker";

const event = {
  id: "0f3c2a10-1111-4222-8333-944445555666",
  kind: "recovery.requested" as const,
  detail: { device: "Chrome / Android", eligibleAt: "2026-10-15T12:00:00.000Z" },
  createdAt: new Date("2026-10-14T12:00:00.000Z"),
};

describe("login alert message (SPEC-LOGIN-ALERT)", () => {
  it("states what happened, when, and how to cancel a pending recovery", () => {
    const message = renderAlertMessage(event);
    expect(message.subject).toContain("リカバリー QR");
    expect(message.body).toContain("Chrome / Android");
    expect(message.body).toContain("取り消して");
    expect(message.body).toContain("/security");
  });

  it("never carries the full event id or a login link, and says Cernere does not send one", () => {
    const { body } = renderAlertMessage(event);
    expect(body).not.toContain(event.id);
    expect(body).toContain(event.id.slice(0, 8));
    expect(body).not.toMatch(/token=|#t=|CRRC1/);
    expect(body).toContain("ログインリンクを送らず");
  });

  it("puts only the code in the verification message", () => {
    expect(renderVerificationMessage("012345").body).toContain("012345");
  });
});

describe("discord rendering", () => {
  it("escapes only variable fields so the fixed URL stays linkable", () => {
    const { body } = renderAlertMessage({ ...event, detail: { device: "@everyone" } }, escapeDiscord);
    expect(body).toContain(String.raw`端末: \@everyone`);
    expect(body).toContain("確認: http");
    expect(body).not.toContain(String.raw`https\:`);
  });
});

describe("escapeDiscord", () => {
  it("neutralizes mentions and markdown from attacker-controlled strings", () => {
    expect(escapeDiscord("@everyone **x** <@123>")).toBe(String.raw`\@everyone \*\*x\*\* \<\@123\>`);
  });
});

describe("outbox backoff", () => {
  it("grows exponentially, keeps jitter within half to full delay, and caps at an hour", () => {
    expect(backoffMs(1, () => 1)).toBe(30_000);
    expect(backoffMs(1, () => 0)).toBe(15_000);
    expect(backoffMs(3, () => 1)).toBe(120_000);
    expect(backoffMs(50, () => 1)).toBe(3_600_000);
  });
});
