CREATE TABLE deployment_runtime_assessments (
  deployment_id TEXT PRIMARY KEY REFERENCES worker_deployments(id),
  state TEXT NOT NULL CHECK(state IN ('dispatchable', 'quarantined')),
  startup_id TEXT,
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 128),
  updated_at_ms INTEGER NOT NULL,
  CHECK((state = 'dispatchable' AND startup_id IS NOT NULL AND reason IS NULL) OR
        (state = 'quarantined' AND reason IS NOT NULL))
) WITHOUT ROWID, STRICT;

INSERT INTO deployment_runtime_assessments
  (deployment_id, state, startup_id, reason, updated_at_ms)
SELECT id, 'quarantined', NULL, 'DEPLOYMENT_ADMISSION_REQUIRED', created_at_ms
FROM worker_deployments;

UPDATE workers SET active_deployment_id = NULL, route_generation = route_generation + 1,
  updated_at_ms = MAX(updated_at_ms, 0)
WHERE active_deployment_id IS NOT NULL;

DROP TRIGGER workers_active_insert_guard;
DROP TRIGGER workers_active_update_guard;

CREATE TRIGGER workers_active_insert_guard
BEFORE INSERT ON workers
WHEN NEW.active_deployment_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM worker_deployments d
    JOIN worker_versions v ON v.id = d.version_id
    JOIN deployment_runtime_assessments a ON a.deployment_id = d.id
    WHERE d.id = NEW.active_deployment_id AND d.worker_id = NEW.id
      AND d.deleted_at_ms IS NULL AND v.worker_id = NEW.id AND v.state = 'ready'
      AND a.state = 'dispatchable'
  ) THEN RAISE(ABORT, 'active deployment invariant') END;
END;

CREATE TRIGGER workers_active_update_guard
BEFORE UPDATE OF active_deployment_id ON workers
WHEN NEW.active_deployment_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM worker_deployments d
    JOIN worker_versions v ON v.id = d.version_id
    JOIN deployment_runtime_assessments a ON a.deployment_id = d.id
    WHERE d.id = NEW.active_deployment_id AND d.worker_id = NEW.id
      AND d.deleted_at_ms IS NULL AND v.worker_id = NEW.id AND v.state = 'ready'
      AND a.state = 'dispatchable'
  ) THEN RAISE(ABORT, 'active deployment invariant') END;
END;

CREATE TRIGGER deployment_assessment_transition_guard
BEFORE UPDATE OF state ON deployment_runtime_assessments
WHEN OLD.state != NEW.state AND NOT (
  OLD.state = 'dispatchable' AND NEW.state = 'quarantined'
)
BEGIN SELECT RAISE(ABORT, 'invalid deployment assessment transition'); END;
