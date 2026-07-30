-- Volputas online-mode profile evidence is owned by Cernere.
-- Large media bytes stay in Volputas protected storage; Cernere owns every
-- user-facing record and the media reference/ownership metadata.
--
-- Every column the Volputas CernereProfileEvidenceStore addresses must be
-- declared here: managed_project.set_user_data drops undeclared columns and
-- fails with "No valid columns to update", so a missing declaration silently
-- disables that evidence medium in online mode.

INSERT INTO managed_projects (
  key,
  name,
  description,
  client_id,
  client_secret_hash,
  schema_definition
)
VALUES (
  'volputas',
  'Volputas',
  'Game preference, qualitative feedback, emotion curves, and persona analysis.',
  gen_random_uuid()::text,
  crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
  '{
    "project": {
      "key": "volputas",
      "name": "Volputas",
      "description": "Game preference, qualitative feedback, emotion curves, and persona analysis"
    },
    "data_sharing": [],
    "user_data": {
      "columns": {
        "gameplay_records": {
          "type": "json",
          "module": "profile_evidence",
          "nullable": true,
          "description": "User-owned gameplay facts and derived dedication scores"
        },
        "voice_records": {
          "type": "json",
          "module": "profile_evidence",
          "nullable": true,
          "description": "User comments scoped to games or in-game content"
        },
        "voicememo_records": {
          "type": "json",
          "module": "profile_evidence",
          "nullable": true,
          "description": "Voice memo transcripts with polarity and referenced Ludus mechanic ids; audio bytes stay in Volputas storage"
        },
        "emotion_curve_records": {
          "type": "json",
          "module": "profile_evidence",
          "nullable": true,
          "description": "Timed emotional reactions and journey metadata for gameplay video"
        },
        "comparison_records": {
          "type": "json",
          "module": "profile_evidence",
          "nullable": true,
          "description": "Pairwise experience-card preferences used as Bradley-Terry input"
        },
        "card_sort_records": {
          "type": "json",
          "module": "profile_evidence",
          "nullable": true,
          "description": "One love/neutral/avoid verdict per Ludus mechanic id; the newest verdict per mechanic is authoritative"
        },
        "annotation_records": {
          "type": "json",
          "module": "profile_evidence",
          "nullable": true,
          "description": "Screenshot moment type and caption; image bytes stay in Volputas storage and are never interpreted"
        },
        "pitch_records": {
          "type": "json",
          "module": "profile_evidence",
          "nullable": true,
          "description": "Ideal-game pitch title, body, and optional reference games"
        },
        "persona_analysis": {
          "type": "json",
          "module": "persona",
          "nullable": true,
          "description": "Latest fingerprinted persona analysis derived from Volputas evidence"
        },
        "profile_media": {
          "type": "json",
          "module": "profile_media",
          "nullable": true,
          "description": "Owned media references, content types, byte sizes, and update timestamps"
        }
      }
    }
  }'::jsonb
)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  schema_definition = EXCLUDED.schema_definition,
  is_active = TRUE,
  updated_at = now();

CREATE TABLE IF NOT EXISTS "project_data_volputas" (
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "gameplay_records"     JSONB,
  "voice_records"        JSONB,
  "voicememo_records"    JSONB,
  "emotion_curve_records" JSONB,
  "comparison_records"   JSONB,
  "card_sort_records"    JSONB,
  "annotation_records"   JSONB,
  "pitch_records"        JSONB,
  "persona_analysis"     JSONB,
  "profile_media"        JSONB,
  _deleted_columns       JSONB NOT NULL DEFAULT '{}',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id)
);

ALTER TABLE "project_data_volputas"
  ADD COLUMN IF NOT EXISTS "gameplay_records" JSONB;
ALTER TABLE "project_data_volputas"
  ADD COLUMN IF NOT EXISTS "voice_records" JSONB;
ALTER TABLE "project_data_volputas"
  ADD COLUMN IF NOT EXISTS "voicememo_records" JSONB;
ALTER TABLE "project_data_volputas"
  ADD COLUMN IF NOT EXISTS "emotion_curve_records" JSONB;
ALTER TABLE "project_data_volputas"
  ADD COLUMN IF NOT EXISTS "comparison_records" JSONB;
ALTER TABLE "project_data_volputas"
  ADD COLUMN IF NOT EXISTS "card_sort_records" JSONB;
ALTER TABLE "project_data_volputas"
  ADD COLUMN IF NOT EXISTS "annotation_records" JSONB;
ALTER TABLE "project_data_volputas"
  ADD COLUMN IF NOT EXISTS "pitch_records" JSONB;
ALTER TABLE "project_data_volputas"
  ADD COLUMN IF NOT EXISTS "persona_analysis" JSONB;
ALTER TABLE "project_data_volputas"
  ADD COLUMN IF NOT EXISTS "profile_media" JSONB;
