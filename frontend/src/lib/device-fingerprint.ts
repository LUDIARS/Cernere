/**
 * デバイスフィンガープリント収集 (本人確認用)
 *
 * - マシン情報   (OS, プラットフォーム, スクリーン, タイムゾーン, 言語)
 * - ブラウザ情報 (UA, ベンダー, ブラウザ名/バージョン)
 *
 * 位置情報 (Geolocation API) は取得しない。デバイス識別は
 * マシン + ブラウザ情報 + 接続元 IP (サーバー側で取得) のみで行う。
 *
 * バックエンド側 (server/src/auth/identity-verification.ts) と
 * 同じスキーマで送信できるよう設計している。
 */

export interface MachineInfo {
  os: string;
  platform: string;
  arch?: string;
  screen: string;
  timezone: string;
  language: string;
}

export interface BrowserInfo {
  ua: string;
  vendor: string;
  browser: string;
  version: string;
}

export interface DeviceFingerprint {
  machine: MachineInfo;
  browser: BrowserInfo;
}

function detectOs(ua: string, platform: string): string {
  if (/Windows NT 10/.test(ua)) return "Windows 10/11";
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Linux/.test(ua) || /Linux/.test(platform)) return "Linux";
  return platform || "Unknown";
}

function detectBrowser(ua: string): { browser: string; version: string } {
  const edge = /Edg\/(\d+(\.\d+)?)/.exec(ua);
  if (edge) return { browser: "Edge", version: edge[1] };
  const opera = /OPR\/(\d+(\.\d+)?)/.exec(ua);
  if (opera) return { browser: "Opera", version: opera[1] };
  const firefox = /Firefox\/(\d+(\.\d+)?)/.exec(ua);
  if (firefox) return { browser: "Firefox", version: firefox[1] };
  const chrome = /Chrome\/(\d+(\.\d+)?)/.exec(ua);
  if (chrome) return { browser: "Chrome", version: chrome[1] };
  const safari = /Version\/(\d+(\.\d+)?).*Safari/.exec(ua);
  if (safari) return { browser: "Safari", version: safari[1] };
  return { browser: "Unknown", version: "" };
}

export function collectMachineInfo(): MachineInfo {
  const nav = navigator;
  const ua = nav.userAgent ?? "";
  const platform = (nav as { platform?: string }).platform ?? "";
  const screen = window.screen ? `${window.screen.width}x${window.screen.height}` : "0x0";
  const timezone = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""; }
    catch { return ""; }
  })();
  return {
    os: detectOs(ua, platform),
    platform,
    arch: (nav as { userAgentData?: { architecture?: string } }).userAgentData?.architecture,
    screen,
    timezone,
    language: nav.language ?? "",
  };
}

export function collectBrowserInfo(): BrowserInfo {
  const nav = navigator;
  const ua = nav.userAgent ?? "";
  const vendor = (nav as { vendor?: string }).vendor ?? "";
  const { browser, version } = detectBrowser(ua);
  return { ua, vendor, browser, version };
}

export function collectDeviceFingerprint(): DeviceFingerprint {
  return {
    machine: collectMachineInfo(),
    browser: collectBrowserInfo(),
  };
}
