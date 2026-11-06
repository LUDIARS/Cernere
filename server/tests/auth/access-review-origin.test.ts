/** 許可待ち一覧の登録経路 (§7)。 @implements SPEC-VENUE-REGISTRATION */

import { describe, expect, it } from "vitest";
import { accessReviewOrigin } from "../../src/auth/access-review-origin.js";

describe("accessReviewOrigin", () => {
  it("shows an outside-venue registration as an exception rejected by default", () => {
    expect(accessReviewOrigin("outside_venue")).toEqual({ registrationOrigin: "outside_venue", exception: true, defaultDecision: "reject" });
  });

  it("treats an unknown stored value as the exception side", () => {
    expect(accessReviewOrigin("anything")).toMatchObject({ exception: true, defaultDecision: "reject" });
  });

  it("does not flag venue or pre-feature registrations", () => {
    expect(accessReviewOrigin("venue")).toEqual({ registrationOrigin: "venue", exception: false, defaultDecision: null });
    expect(accessReviewOrigin(null)).toEqual({ registrationOrigin: null, exception: false, defaultDecision: null });
  });
});
