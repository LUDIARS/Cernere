/** The private signing key stays in the browser's origin-scoped IndexedDB. */
export interface DeviceRegistration { deviceId: string; key: CryptoKey }
export interface DeviceCandidate { key: CryptoKey; publicKey: string }

function encode(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createDeviceCandidate(): Promise<DeviceCandidate> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { key: pair.privateKey, publicKey: encode(await crypto.subtle.exportKey("spki", pair.publicKey)) };
}

export async function deviceRegistration(project: string, value?: DeviceRegistration): Promise<DeviceRegistration | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("cernere-device-proofs", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("devices");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<DeviceRegistration | undefined>((resolve, reject) => {
      const tx = db.transaction("devices", value ? "readwrite" : "readonly");
      const store = tx.objectStore("devices");
      const op = value ? store.put(value, project) : store.get(project);
      tx.oncomplete = () => resolve(value ?? op.result);
      tx.onabort = () => reject(tx.error ?? new Error("端末登録を保存できませんでした"));
    });
  } finally { db.close(); }
}

export async function signDeviceChallenge(registration: DeviceRegistration, challenge: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error("端末確認の要求が無効です");
  return encode(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, registration.key, new TextEncoder().encode(challenge)));
}
