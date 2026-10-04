/** onsite_mfa は管理者所有で、 required=true のときだけ要求になる。 @implements SPEC-MFA-ONSITE */

import { describe, expect, it } from "vitest";
import { onsiteRequirementOf } from "../../src/project/onsite-mfa.js";
import { splitAdminOwnedSchemaFields } from "../../src/project/admin-owned-fields.js";
import { projectDefinitionSchema } from "../../src/project/schema.js";
import { preserveExistingDefinitionFields } from "../../src/project/service.js";

describe("onsiteRequirementOf", () => {
  it("returns null unless onsite_mfa.required is true", () => {
    expect(onsiteRequirementOf(null)).toBeNull();
    expect(onsiteRequirementOf({})).toBeNull();
    expect(onsiteRequirementOf({ onsite_mfa: { required: false, min_assurance: "high" } })).toBeNull();
  });

  it("derives the minimum assurance and deduplicated, sorted allowed places", () => {
    expect(onsiteRequirementOf({ onsite_mfa: { required: true, min_assurance: "medium" } }))
      .toEqual({ minAssurance: "medium", allowedPlaceIds: null });
    expect(onsiteRequirementOf({ onsite_mfa: { required: true, min_assurance: "high", allowed_place_ids: ["b", "a", "b"] } }))
      .toEqual({ minAssurance: "high", allowedPlaceIds: ["a", "b"] });
  });

  it("fails closed for a required but malformed declaration instead of dropping onsite", () => {
    expect(() => onsiteRequirementOf({ onsite_mfa: { required: true, min_assurance: "low" } })).toThrow();
    expect(() => onsiteRequirementOf({ onsite_mfa: { required: true, min_assurance: "high", allowed_place_ids: [] } })).toThrow();
  });
});

describe("onsite_mfa as an administrator-owned schema field", () => {
  it("is never kept from a project client's update_schema payload", () => {
    const { projectOwned, submittedAdminOwned } = splitAdminOwnedSchemaFields({
      project: { key: "Schedula", name: "Schedula" },
      onsite_mfa: { required: false, min_assurance: "medium" },
      service_scopes: ["onsite-mfa:submit"],
      user_data: { columns: {} },
    });
    expect(projectOwned).toEqual({ project: { key: "Schedula", name: "Schedula" }, user_data: { columns: {} } });
    expect(submittedAdminOwned).toEqual(["service_scopes", "onsite_mfa"]);
  });

  it("keeps the administrator's existing onsite_mfa through a project auto-sync", () => {
    const existing = projectDefinitionSchema.parse({ project: { key: "Schedula", name: "Schedula" },
      onsite_mfa: { required: true, min_assurance: "high", allowed_place_ids: ["place-1"] } });
    const submitted = projectDefinitionSchema.parse({ project: { key: "Schedula", name: "Schedula" } });
    expect(preserveExistingDefinitionFields(submitted, existing).onsite_mfa)
      .toEqual({ required: true, min_assurance: "high", allowed_place_ids: ["place-1"] });
  });

  it("is validated in the project definition schema", () => {
    expect(projectDefinitionSchema.safeParse({ project: { key: "Schedula", name: "S" },
      onsite_mfa: { required: true, min_assurance: "manual" } }).success).toBe(false);
  });
});
