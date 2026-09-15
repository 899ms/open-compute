ALTER TABLE cron_runs RENAME TO cron_runs_v1;
DROP INDEX cron_runs_due;
DROP INDEX cron_runs_expired;
DROP TRIGGER cron_runs_insert_guard;
DROP TRIGGER cron_runs_identity_guard;
DROP TRIGGER cron_runs_transition_guard;

CREATE TABLE cron_runs (
  id                     TEXT PRIMARY KEY
                         CHECK(length(id) = 36 AND id = lower(id)),
  activation_id          TEXT NOT NULL REFERENCES cron_schedules(activation_id),
  activation_generation  INTEGER NOT NULL CHECK(activation_generation >= 1),
  scheduled_at_ms        INTEGER NOT NULL CHECK(scheduled_at_ms >= 0),
  version_id             TEXT NOT NULL
                         CHECK(length(version_id) = 36 AND version_id = lower(version_id)),
  execution_generation   INTEGER NOT NULL CHECK(execution_generation >= 1),
  expression             TEXT NOT NULL CHECK(length(expression) BETWEEN 1 AND 256),
  state                  TEXT NOT NULL CHECK(state IN (
                           'ready', 'claimed', 'complete', 'failed', 'skipped'
                         )),
  attempt                INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 4),
  no_retry               INTEGER NOT NULL DEFAULT 0 CHECK(no_retry IN (0, 1)),
  next_attempt_at_ms     INTEGER,
  claim_token            BLOB,
  claimed_at_ms          INTEGER,
  claim_until_ms         INTEGER,
  first_dispatched_at_ms INTEGER,
  dispatch_deadline_at_ms INTEGER,
  last_unknown_reason    TEXT CHECK(last_unknown_reason IS NULL OR last_unknown_reason IN (
                           'transport-timeout', 'connection-loss', 'malformed-response',
                           'runtime-generation-lost'
                         )),
  error_code             TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  created_at_ms          INTEGER NOT NULL,
  completed_at_ms        INTEGER,
  UNIQUE(activation_id, activation_generation, scheduled_at_ms),
  CHECK((first_dispatched_at_ms IS NULL AND dispatch_deadline_at_ms IS NULL AND attempt = 0) OR
        (first_dispatched_at_ms IS NOT NULL AND dispatch_deadline_at_ms = first_dispatched_at_ms + 900000)),
  CHECK(
    (state = 'ready' AND next_attempt_at_ms IS NOT NULL AND claim_token IS NULL AND
      claimed_at_ms IS NULL AND claim_until_ms IS NULL AND completed_at_ms IS NULL) OR
    (state = 'claimed' AND next_attempt_at_ms IS NULL AND length(claim_token) = 32 AND
      claimed_at_ms IS NOT NULL AND claim_until_ms > claimed_at_ms AND
      claim_until_ms <= dispatch_deadline_at_ms AND completed_at_ms IS NULL) OR
    (state IN ('complete', 'failed', 'skipped') AND next_attempt_at_ms IS NULL AND
      claim_token IS NULL AND claimed_at_ms IS NULL AND claim_until_ms IS NULL AND
      completed_at_ms IS NOT NULL)
  )
) STRICT;

INSERT INTO cron_runs (
  id, activation_id, activation_generation, scheduled_at_ms, version_id,
  execution_generation, expression, state, attempt, no_retry, next_attempt_at_ms,
  claim_token, claimed_at_ms, claim_until_ms, first_dispatched_at_ms,
  dispatch_deadline_at_ms, last_unknown_reason, error_code, created_at_ms, completed_at_ms
)
SELECT id, activation_id, activation_generation, scheduled_at_ms, version_id,
       execution_generation, expression, state,
       CASE WHEN state IN ('claimed', 'complete', 'failed', 'skipped')
            THEN MIN(attempt + 1, 4) ELSE attempt END,
       no_retry, next_attempt_at_ms, claim_token, claimed_at_ms,
       CASE WHEN state = 'claimed' THEN MIN(claim_until_ms, claimed_at_ms + 900000)
            ELSE claim_until_ms END,
       CASE WHEN state = 'claimed' THEN claimed_at_ms
            WHEN attempt > 0 OR state IN ('complete', 'failed', 'skipped') THEN created_at_ms
            ELSE NULL END,
       CASE WHEN state = 'claimed' THEN claimed_at_ms + 900000
            WHEN attempt > 0 OR state IN ('complete', 'failed', 'skipped') THEN created_at_ms + 900000
            ELSE NULL END,
       NULL, error_code, created_at_ms, completed_at_ms
FROM cron_runs_v1;
DROP TABLE cron_runs_v1;

CREATE INDEX cron_runs_due
ON cron_runs(state, next_attempt_at_ms, scheduled_at_ms, id)
WHERE state = 'ready';
CREATE INDEX cron_runs_expired
ON cron_runs(claim_until_ms, id)
WHERE state = 'claimed';
CREATE TRIGGER cron_runs_insert_guard
BEFORE INSERT ON cron_runs
WHEN NEW.state != 'ready' OR NEW.attempt != 0 OR NEW.no_retry != 0 OR
     NEW.first_dispatched_at_ms IS NOT NULL OR NEW.dispatch_deadline_at_ms IS NOT NULL OR
     NEW.last_unknown_reason IS NOT NULL OR
     NOT EXISTS (
       SELECT 1 FROM cron_schedules s
       WHERE s.activation_id = NEW.activation_id
         AND s.activation_generation = NEW.activation_generation
         AND s.version_id = NEW.version_id
         AND s.execution_generation = NEW.execution_generation
         AND s.expression = NEW.expression AND s.state = 'accepting'
     )
BEGIN
  SELECT RAISE(ABORT, 'cron run insert authority invariant');
END;
CREATE TRIGGER cron_runs_identity_guard
BEFORE UPDATE ON cron_runs
WHEN OLD.id != NEW.id OR OLD.activation_id != NEW.activation_id OR
     OLD.activation_generation != NEW.activation_generation OR
     OLD.scheduled_at_ms != NEW.scheduled_at_ms OR
     OLD.version_id != NEW.version_id OR
     OLD.execution_generation != NEW.execution_generation OR
     OLD.expression != NEW.expression OR OLD.created_at_ms != NEW.created_at_ms OR
     (OLD.first_dispatched_at_ms IS NOT NULL AND
       (OLD.first_dispatched_at_ms != NEW.first_dispatched_at_ms OR
        OLD.dispatch_deadline_at_ms != NEW.dispatch_deadline_at_ms))
BEGIN
  SELECT RAISE(ABORT, 'cron run identity is immutable');
END;
CREATE TRIGGER cron_runs_transition_guard
BEFORE UPDATE ON cron_runs
WHEN NOT (
  (OLD.state = 'ready' AND NEW.state = 'claimed' AND
    NEW.attempt = OLD.attempt + 1 AND NEW.no_retry = OLD.no_retry AND
    NEW.first_dispatched_at_ms IS NOT NULL) OR
  (OLD.state = 'claimed' AND NEW.state = 'ready' AND
    NEW.attempt = OLD.attempt AND NEW.no_retry = OLD.no_retry) OR
  (OLD.state = 'claimed' AND NEW.state IN ('complete', 'failed', 'skipped') AND
    NEW.attempt = OLD.attempt) OR
  (OLD.state = 'ready' AND NEW.state IN ('failed', 'skipped') AND
    NEW.attempt = OLD.attempt) OR
  (OLD.state = NEW.state AND OLD.state = 'claimed' AND
    OLD.attempt = NEW.attempt AND OLD.claim_token = NEW.claim_token) OR
  (OLD.state = NEW.state AND OLD.state IN ('complete', 'failed', 'skipped') AND
    OLD.id = NEW.id)
)
BEGIN
  SELECT RAISE(ABORT, 'cron run transition invariant');
END;
