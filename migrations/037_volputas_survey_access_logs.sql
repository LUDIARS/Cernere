-- Volputas survey access audit trail.
--
-- Volputas survey responses are read and overwritten through the project
-- WebSocket command path (`/ws/project`), which does not pass through the user
-- WS dispatcher and therefore never reaches `operation_logs`. Without this table
-- the most sensitive store Cernere holds for a project would have no audit
-- trail at all.
--
-- Confidentiality: this table stores WHO touched WHICH survey and HOW IT ENDED.
-- It never stores answer values, payload bodies, tokens or credentials, and the
-- error column is a closed enumeration rather than free text, so an exception
-- message can never leak an answer into the audit sink.
--
-- 037 continues after 036; numbers 030-035 stay reserved for parallel WIP
-- branches and are intentionally left unused here.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS volputas_survey_access_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Project key bound to the authenticated project WS connection. For denied
  -- attempts this is the project that tried, not necessarily 'volputas'.
  project_key TEXT NOT NULL,
  -- Deliberately NOT a foreign key to users(id): a denied or malformed command
  -- may carry an unknown or attacker-chosen user id, and a rejected insert
  -- would drop the very record the audit trail exists for. Values that are not
  -- UUID-shaped are recorded as NULL by the writer, and account deletion purges
  -- these rows explicitly (see server/src/project/service.ts).
  user_id UUID,
  -- NULL for list_response_statuses (it spans many surveys) and for payloads
  -- rejected before a survey id could be read.
  survey_id UUID,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_volputas_survey_access_log_project_key CHECK (
    char_length(project_key) <= 100
  ),
  CONSTRAINT chk_volputas_survey_access_log_action CHECK (
    action IN ('list_response_statuses', 'get_response', 'save_response')
  ),
  CONSTRAINT chk_volputas_survey_access_log_status CHECK (
    status IN ('ok', 'error', 'denied')
  ),
  -- Closed enumeration + fail-closed pairing with status. Free-text error
  -- messages are rejected by the database, not merely by application code.
  CONSTRAINT chk_volputas_survey_access_log_error_code CHECK (
    (status = 'ok' AND error_code IS NULL)
    OR (status <> 'ok' AND error_code IN (
      'project_not_authorized',
      'invalid_payload',
      'storage_failure',
      'internal_error'
    ))
  )
);

CREATE INDEX IF NOT EXISTS idx_volputas_survey_access_logs_user
  ON volputas_survey_access_logs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_volputas_survey_access_logs_project
  ON volputas_survey_access_logs(project_key, created_at DESC);

-- Retention sweep (spec/data/retention.md) deletes by age; keep it index-driven.
CREATE INDEX IF NOT EXISTS idx_volputas_survey_access_logs_created
  ON volputas_survey_access_logs(created_at);
