CREATE TABLE worker_delete_intents (
  worker_id TEXT PRIMARY KEY REFERENCES workers(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  request_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  CHECK(length(request_id) BETWEEN 1 AND 128)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER worker_version_delete_intent_guard
BEFORE INSERT ON worker_versions
WHEN EXISTS (SELECT 1 FROM worker_delete_intents i WHERE i.worker_id = NEW.worker_id)
BEGIN SELECT RAISE(ABORT, 'worker deletion in progress'); END;

CREATE TRIGGER worker_deployment_delete_intent_guard
BEFORE INSERT ON worker_deployments
WHEN EXISTS (SELECT 1 FROM worker_delete_intents i WHERE i.worker_id = NEW.worker_id)
BEGIN SELECT RAISE(ABORT, 'worker deletion in progress'); END;
