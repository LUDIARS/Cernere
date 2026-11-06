/** 080: venue challenge と users.registration_origin を冪等に足し、削除・型変更をしない。 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../migrations/080_venue_registration.sql", import.meta.url), "utf8");
const body = migration.replace(/--[^\n]*\n/g, "");

describe("080_venue_registration", () => {
  it("creates the challenge table with a hashed, unique nonce", () => {
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS venue_registration_challenges/);
    expect(body).toMatch(/nonce_hash TEXT NOT NULL UNIQUE/);
    expect(body).not.toMatch(/\bnonce TEXT/);
  });

  it("adds registration origin columns idempotently and limits the origin vocabulary", () => {
    expect(body).toMatch(/ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_origin TEXT/);
    expect(body).toMatch(/ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_place_id TEXT/);
    expect(body).toMatch(/registration_origin IN \('venue', 'outside_venue'\)/);
  });

  it("never drops or retypes anything", () => {
    expect(body).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(body).not.toMatch(/ALTER COLUMN[^;]*TYPE/i);
  });
});
