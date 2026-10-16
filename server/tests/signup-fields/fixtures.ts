/** signup_fields のテスト共通の列定義と宣言。 */
import type { ConsentDeclaration } from "../../src/consent/declaration-schema.js";
import type { SignupColumns } from "../../src/signup-fields/declaration.js";
import type { SignupFieldsDeclaration } from "../../src/signup-fields/declaration-schema.js";
import type { SharedProjectDefinition } from "../../src/signup-fields/shared-source.js";

export const columns: SignupColumns = {
  affiliation: { type: "text", module: "member" },
  grade: { type: "text", module: "member" },
  bio: { type: "text", module: "social" },
  agreed: { type: "boolean", module: "member" },
  seat: { type: "integer", module: "member" },
  legacy: { type: "text", module: "member", _deleted: true },
  joined_at: { type: "timestamp", module: "member" },
};

/** social は推奨 (外せる)、member は必須の module。 */
export const consent: ConsentDeclaration = {
  version: 1,
  permissions: [
    { key: "user_data.module:member", level: "required", purpose: "メンバー一覧", visible_to: ["service_users"] },
    { key: "user_data.module:social", level: "recommended", purpose: "紹介", visible_to: ["public"] },
  ],
};

export const declaration: SignupFieldsDeclaration = {
  version: 1,
  fields: [
    { column: "affiliation", label: "所属", required: true, input: "text", max_length: 10 },
    { column: "grade", label: "学年", required: false, input: "select", options: [{ value: "1", label: "1 年" }, { value: "2", label: "2 年" }] },
    { column: "bio", label: "自己紹介", required: false, input: "textarea" },
  ],
};

/** 共有元 project (vantan_user 相当) の定義。EducationLab へ profile を readwrite、aedilis へ read で共有している。 */
export const sharedProfile: SharedProjectDefinition = {
  columns: {
    name: { type: "text", module: "profile" },
    role_title: { type: "text", module: "profile" },
    department_name: { type: "text", module: "profile" },
    grade: { type: "integer", module: "profile" },
    old_title: { type: "text", module: "profile", _deleted: true },
    note: { type: "text", module: "private" },
  },
  dataSharing: [
    { project_key: "aedilis", modules: ["profile"], access: "read" },
    { project_key: "EducationLab", modules: ["profile"], access: "readwrite" },
    { project_key: "glab", modules: ["profile"], columns: ["name", "role_title", "department_name"], access: "readwrite" },
  ],
};

/** GLAB の宣言 (migration 074 と同じ)。 */
export const sharedDeclaration: SignupFieldsDeclaration = {
  version: 1,
  fields: [
    { project: "vantan_user", column: "name", label: "名前", required: true, input: "text", max_length: 200 },
    { project: "vantan_user", column: "role_title", label: "役職", required: true, input: "text", max_length: 200 },
    { project: "vantan_user", column: "department_name", label: "学科", required: true, input: "text", max_length: 200 },
  ],
};
