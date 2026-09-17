CREATE TABLE r0_route_guard (
  valid INTEGER NOT NULL CHECK(valid = 1)
) STRICT;

INSERT INTO r0_route_guard(valid)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1
  FROM workers w
  WHERE w.ownership = 'tenant'
    AND (
      SELECT COUNT(*)
      FROM worker_routes r
      WHERE r.worker_id = w.id
        AND r.account_id = w.account_id
        AND r.kind = 'platform_path'
        AND r.state = CASE WHEN w.deleted_at_ms IS NULL THEN 'active' ELSE 'tombstoned' END
    ) != 1
) THEN 1 ELSE 0 END;

DROP TABLE r0_route_guard;

CREATE TABLE hostname_claims (
  id TEXT PRIMARY KEY,
  hostname_ascii TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  namespace TEXT NOT NULL CHECK(namespace = 'worker'),
  exposure TEXT NOT NULL CHECK(exposure = 'local'),
  state TEXT NOT NULL CHECK(state IN ('active', 'tombstoned')),
  generation INTEGER NOT NULL CHECK(generation > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  CHECK(hostname_ascii = lower(hostname_ascii)),
  CHECK(hostname_ascii NOT GLOB '*[^a-z0-9.-]*'),
  CHECK(instr(hostname_ascii, '..') = 0),
  CHECK(substr(hostname_ascii, -10) = '.localhost'),
  CHECK(instr(hostname_ascii, ':') = 0),
  CHECK(instr(hostname_ascii, '/') = 0),
  CHECK((state = 'active' AND deleted_at_ms IS NULL) OR
        (state = 'tombstoned' AND deleted_at_ms IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX active_hostname_claims
ON hostname_claims(hostname_ascii)
WHERE state = 'active';

CREATE UNIQUE INDEX hostname_claim_account_identity
ON hostname_claims(id, account_id);

CREATE UNIQUE INDEX workers_account_identity
ON workers(id, account_id);

CREATE TABLE worker_host_routes (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  worker_id TEXT NOT NULL,
  path_prefix TEXT NOT NULL CHECK(path_prefix = '/'),
  entrypoint TEXT,
  state TEXT NOT NULL CHECK(state IN ('active', 'tombstoned')),
  generation INTEGER NOT NULL CHECK(generation > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  CHECK((state = 'active' AND deleted_at_ms IS NULL) OR
        (state = 'tombstoned' AND deleted_at_ms IS NOT NULL)),
  FOREIGN KEY(claim_id, account_id) REFERENCES hostname_claims(id, account_id),
  FOREIGN KEY(worker_id, account_id) REFERENCES workers(id, account_id)
) STRICT;

CREATE UNIQUE INDEX active_worker_host_routes
ON worker_host_routes(worker_id)
WHERE state = 'active';

INSERT INTO hostname_claims
  (id, hostname_ascii, account_id, namespace, exposure, state, generation,
   created_at_ms, updated_at_ms, deleted_at_ms)
SELECT r.id, w.name || '.' || lower(w.account_id) || '.localhost', w.account_id,
       'worker', 'local', r.state, r.generation,
       r.created_at_ms, r.updated_at_ms, r.deleted_at_ms
FROM workers w
JOIN worker_routes r
  ON r.worker_id = w.id
 AND r.account_id = w.account_id
 AND r.kind = 'platform_path'
WHERE w.ownership = 'tenant'
  AND r.state IN ('active', 'tombstoned');

INSERT INTO worker_host_routes
  (id, claim_id, account_id, worker_id, path_prefix, entrypoint, state,
   generation, created_at_ms, updated_at_ms, deleted_at_ms)
SELECT r.id, r.id, r.account_id, r.worker_id, '/', NULL, r.state,
       r.generation, r.created_at_ms, r.updated_at_ms, r.deleted_at_ms
FROM workers w
JOIN worker_routes r
  ON r.worker_id = w.id
 AND r.account_id = w.account_id
 AND r.kind = 'platform_path'
WHERE w.ownership = 'tenant'
  AND r.state IN ('active', 'tombstoned');

DROP TABLE worker_routes;
