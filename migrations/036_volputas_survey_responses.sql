-- Volputas owns survey definitions; Cernere owns each authenticated user's answers.
-- 036 intentionally skips locally reserved WIP numbers 030-035 to avoid parallel
-- migration collisions before those branches are integrated.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
  'Game preference and qualitative survey service.',
  gen_random_uuid()::text,
  crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
  '{
    "project": {
      "key": "volputas",
      "name": "Volputas",
      "description": "Game preference and qualitative survey service"
    },
    "data_sharing": [],
    "user_data": { "columns": {} }
  }'::jsonb
)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  schema_definition = EXCLUDED.schema_definition,
  is_active = TRUE,
  updated_at = now();

INSERT INTO project_credential_issuers (
  target_project_key,
  issuer_project_key,
  is_active
)
VALUES ('volputas', 'excubitor', TRUE)
ON CONFLICT (target_project_key, issuer_project_key) DO UPDATE SET
  is_active = TRUE,
  updated_at = now();

CREATE TABLE IF NOT EXISTS volputas_survey_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_volputas_survey_response_survey_user
    UNIQUE (survey_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_volputas_survey_responses_user
  ON volputas_survey_responses(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS volputas_survey_answers (
  response_id UUID NOT NULL
    REFERENCES volputas_survey_responses(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  answer_text TEXT,
  answer_int INTEGER,
  PRIMARY KEY (response_id, question_id),
  CONSTRAINT chk_volputas_survey_answer_exactly_one CHECK (
    (answer_text IS NOT NULL AND answer_int IS NULL)
    OR (answer_text IS NULL AND answer_int IS NOT NULL)
  ),
  CONSTRAINT chk_volputas_survey_answer_question_id CHECK (
    question_id ~ '^[a-z][a-z0-9_-]{0,99}$'
  ),
  CONSTRAINT chk_volputas_survey_answer_text_length CHECK (
    answer_text IS NULL OR char_length(answer_text) <= 4000
  )
);

CREATE INDEX IF NOT EXISTS idx_volputas_survey_answers_response
  ON volputas_survey_answers(response_id);

-- Migration 033 may already have created the same response tables without
-- named/domain-boundary constraints. CREATE TABLE IF NOT EXISTS does not
-- converge an existing table, so add every required constraint explicitly.
-- Each convergence step is isolated because the migration runner may ignore
-- duplicate-object errors per statement. Incompatible legacy data is raised
-- with P0001 so the migration fails closed instead of being marked applied.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_volputas_survey_response_survey_user'
      AND conrelid = 'volputas_survey_responses'::regclass
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM volputas_survey_responses
      GROUP BY survey_id, user_id
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Cannot add Volputas survey uniqueness: duplicate survey/user rows exist';
    END IF;

    IF to_regclass('uq_volputas_survey_response_survey_user') IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Cannot add Volputas survey uniqueness: relation name is already occupied';
    END IF;

    ALTER TABLE volputas_survey_responses
      ADD CONSTRAINT uq_volputas_survey_response_survey_user
      UNIQUE (survey_id, user_id);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_volputas_survey_answer_exactly_one'
      AND conrelid = 'volputas_survey_answers'::regclass
  ) THEN
    ALTER TABLE volputas_survey_answers
      ADD CONSTRAINT chk_volputas_survey_answer_exactly_one CHECK (
        (answer_text IS NOT NULL AND answer_int IS NULL)
        OR (answer_text IS NULL AND answer_int IS NOT NULL)
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_volputas_survey_answer_question_id'
      AND conrelid = 'volputas_survey_answers'::regclass
  ) THEN
    ALTER TABLE volputas_survey_answers
      ADD CONSTRAINT chk_volputas_survey_answer_question_id CHECK (
        question_id ~ '^[a-z][a-z0-9_-]{0,99}$'
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_volputas_survey_answer_text_length'
      AND conrelid = 'volputas_survey_answers'::regclass
  ) THEN
    ALTER TABLE volputas_survey_answers
      ADD CONSTRAINT chk_volputas_survey_answer_text_length CHECK (
        answer_text IS NULL OR char_length(answer_text) <= 4000
      );
  END IF;
END;
$$;
