/**
 * デバイスフィンガープリント収集
 *
 * ブラウザから本人確認に使う以下の情報を収集する:
 *   - マシン情報   (OS, プラットフォーム, スクリーン, タイムゾーン, 言語)
 *   - ブラウザ情報 (UA, ベンダー, ブラウザ名/バージョン)
 *   - 位置情報     (Geolocation API、ユーザー許可がある場合)
 *
 * 位置情報の取得はプライバシーへの配慮のためタイムアウトを設け、
 * ユーザーが拒否した場合はそのまま空オブジェクトを返す。
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

export interface GeoInfo {
  /** 緯度 (geolocation 取得時のみ) */
  latitude?: number;
  /** 経度 (geolocation 取得時のみ) */
  longitude?: number;
  /** 精度 (m) */
  accuracy?: number;
  /** 取得元 ("geolocation" | "denied" | "unavailable") */
  source: "geolocation" | "denied" | "unavailable";
}

export interface DeviceFingerprint {
  machine: MachineInfo;
  browser: BrowserInfo;
  geo: GeoInfo;
}

// ── マシン / ブラウザ ───────────────────────────────────────

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
  // 順序が重要: Edge → Chrome → Safari の順に判定
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
  const nav = typeof navigator !== "undefined" ? navigator : ({} as Navigator);
  const win = typeof window !== "undefined" ? window : ({} as Window);
  const ua = nav.userAgent ?? "";
  // navigator.platform は deprecated だが、現状で OS 判定のフォールバックとして使う
  const platform = (nav as { platform?: string }).platform ?? "";
  const screen = win.screen ? `${win.screen.width}x${win.screen.height}` : "0x0";
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
  const nav = typeof navigator !== "undefined" ? navigator : ({} as Navigator);
  const ua = nav.userAgent ?? "";
  const vendor = (nav as { vendor?: string }).vendor ?? "";
  const { browser, version } = detectBrowser(ua);
  return { ua, vendor, browser, version };
}

// ── 位置情報 ─────────────────────────────────────────────────

/**
 * Geolocation API でブラウザの現在位置を取得する。
 * ユーザーが拒否した場合や非対応環境では source を "denied" / "unavailable" にして返す。
 *
 * @param timeoutMs - 取得タイムアウト (default: 5 秒)
 */
export function collectGeoInfo(timeoutMs = 5000): Promise<GeoInfo> {
  return new Promise((resolve) => {
    if (
      typeof navigator === "undefined" ||
      !navigator.geolocation ||
      typeof navigator.geolocation.getCurrentPosition !== "function"
    ) {
      resolve({ source: "unavailable" });
      return;
    }

    let settled = false;
    const finish = (g: GeoInfo) => {
      if (settled) return;
      settled = true;
      resolve(g);
    };

    const timer = setTimeout(() => finish({ source: "denied" }), timeoutMs);

    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer);
          finish({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            source: "geolocation",
          });
        },
        () => {
          clearTimeout(timer);
          finish({ source: "denied" });
        },
        { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 5 * 60 * 1000 },
      );
    } catch {
      clearTimeout(timer);
      finish({ source: "unavailable" });
    }
  });
}

// ── 公開エントリポイント ─────────────────────────────────────

/**
 * 本人確認用フィンガープリントをまとめて収集する。
 *
 * @param options.requestGeo - true (default) なら Geolocation API を呼ぶ。
 *                              false なら geo は { source: "unavailable" } のみ返す。
 * @param options.geoTimeoutMs - Geolocation 取得タイムアウト (default: 5 秒)
 */
export async function collectDeviceFingerprint(options: {
  requestGeo?: boolean;
  geoTimeoutMs?: number;
} = {}): Promise<DeviceFingerprint> {
  const { requestGeo = true, geoTimeoutMs = 5000 } = options;
  const machine = collectMachineInfo();
  const browser = collectBrowserInfo();
  const geo = requestGeo
    ? await collectGeoInfo(geoTimeoutMs)
    : ({ source: "unavailable" } as GeoInfo);
  return { machine, browser, geo };
}
