/** 引き継ぎ要求の実体 (Redis)。テストは JoinRequestStore に偽の Redis を渡す。 */

import { redis } from "../redis.js";
import { JoinRequestStore } from "./join-request.js";

export const joinRequestStore = new JoinRequestStore({
  get: (key) => redis.get(key),
  set: (key, value, mode, ttlMs) => redis.set(key, value, mode, ttlMs),
  getdel: (key) => redis.getdel(key),
  del: (key) => redis.del(key),
  setnx: async (key, value, ttlMs) => (await redis.set(key, value, "PX", ttlMs, "NX")) === "OK",
});
