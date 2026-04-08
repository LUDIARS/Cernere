import type { AuthStorage } from "./types.js";

const STORAGE_PREFIX = "cernere:";

/** ブラウザ localStorage を使用 */
export function createLocalStorage(): AuthStorage {
  return {
    get: (key) => localStorage.getItem(STORAGE_PREFIX + key),
    set: (key, value) => localStorage.setItem(STORAGE_PREFIX + key, value),
    remove: (key) => localStorage.removeItem(STORAGE_PREFIX + key),
  };
}

/** ブラウザ sessionStorage を使用 */
export function createSessionStorage(): AuthStorage {
  return {
    get: (key) => sessionStorage.getItem(STORAGE_PREFIX + key),
    set: (key, value) => sessionStorage.setItem(STORAGE_PREFIX + key, value),
    remove: (key) => sessionStorage.removeItem(STORAGE_PREFIX + key),
  };
}

/** メモリ内保存 (タブを閉じると消える) */
export function createMemoryStorage(): AuthStorage {
  const store = new Map<string, string>();
  return {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => store.set(key, value),
    remove: (key) => store.delete(key),
  };
}
