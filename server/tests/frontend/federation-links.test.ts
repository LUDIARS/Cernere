/**
 * 引き継ぎメニューの行き先と QR の読み取り (spec/plan/2026-10-15-account-federation-design.md §4 / §5)。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { joinUrlKind, readJoinToken } from "../../../frontend/src/lib/federation-qr";

// QR の token は base64url 43 文字。中身に意味は無いので同じ文字の繰り返しで足りる。
const TOKEN = "t".repeat(43);

beforeAll(() => {
  // continue-links は Cernere 内のパスを window.location.origin 基準で組み立てる。
  (globalThis as { window?: unknown }).window = { location: { origin: "https://cernere.example.com" } };
});

describe("readJoinToken", () => {
  it("QR の URL の fragment から token を取り出す", () => {
    expect(readJoinToken(`https://cernere.example.com/federate/approve#t=${TOKEN}`)).toBe(TOKEN);
  });

  it("token そのものも受け付ける", () => {
    expect(readJoinToken(`  ${TOKEN}  `)).toBe(TOKEN);
  });

  it("token の無い URL や形の違う値は読まない", () => {
    expect(readJoinToken("https://cernere.example.com/federate/approve")).toBeNull();
    expect(readJoinToken("https://cernere.example.com/federate/join#t=<script>")).toBeNull();
    expect(readJoinToken("")).toBeNull();
  });
});

describe("joinUrlKind", () => {
  it("承認する側の QR と加わる側の QR を見分ける", () => {
    expect(joinUrlKind(`https://cernere.example.com/federate/approve#t=${TOKEN}`)).toBe("approve");
    expect(joinUrlKind(`https://cernere.example.com/federate/join#t=${TOKEN}`)).toBe("join");
    expect(joinUrlKind("https://cernere.example.com/recover")).toBeNull();
  });
});

describe("continue-links", () => {
  it("引き継ぎメニューは Cernere 内のパスだけを渡す (open redirect にしない)", async () => {
    const { continueMenuUrl } = await import("../../../frontend/src/pages/continue/continue-links");
    const url = new URL(continueMenuUrl("https://evil.example.com/", "//evil.example.com"), "https://cernere.example.com");
    expect(url.pathname).toBe("/continue");
    expect(url.searchParams.get("return")).toBe("/");
    expect(url.searchParams.get("login")).toBe("/");
  });

  it("① はログイン画面へ戻り、別の端末のパスキーを使う印を付ける (元のクエリは残す)", async () => {
    const { crossDeviceLoginUrl, wantsCrossDevice } = await import("../../../frontend/src/pages/continue/continue-links");
    const url = crossDeviceLoginUrl("/composite/login?origin=https%3A%2F%2Fsvc.example.com");
    expect(url.startsWith("/composite/login?")).toBe(true);
    expect(new URLSearchParams(url.split("?")[1]).get("origin")).toBe("https://svc.example.com");
    expect(wantsCrossDevice(url.slice(url.indexOf("?")))).toBe(true);
  });

  it("② は戻り先を付けて /federate/join へ", async () => {
    const { federateJoinUrl } = await import("../../../frontend/src/pages/continue/continue-links");
    expect(federateJoinUrl("/profile")).toBe("/federate/join?return=%2Fprofile");
  });
});
