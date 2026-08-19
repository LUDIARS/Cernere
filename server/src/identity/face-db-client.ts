/**
 * face 系ストアが db 本体と transaction (tx) の両方で使える最小クライアント型。
 * drizzle の tx 型を各所で書き回さず、必要なメソッドだけを構造的に要求する。
 */

import { db } from "../db/connection.js";

export type FaceDbClient = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;
