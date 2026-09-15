ALTER TABLE chunks RENAME TO chunks_v1;
ALTER TABLE index_job_items RENAME TO index_job_items_v1;
ALTER TABLE item_logs RENAME TO item_logs_v1;
ALTER TABLE item_generations RENAME TO item_generations_v1;
ALTER TABLE items RENAME TO items_v1;
DROP INDEX chunks_by_active_item;

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('builtin','r2','open-compute:manual')),
  source_provider TEXT,
  source_namespace TEXT,
  key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','error','skipped','outdated')),
  active_generation INTEGER CHECK(active_generation > 0),
  desired_generation INTEGER NOT NULL CHECK(desired_generation > 0),
  metadata_json BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK((source = 'open-compute:manual' AND source_provider IS NOT NULL AND source_namespace IS NOT NULL)
     OR (source != 'open-compute:manual' AND source_provider IS NULL AND source_namespace IS NULL))
) STRICT;
CREATE UNIQUE INDEX items_official_source_key ON items(source,key)
WHERE source != 'open-compute:manual';
CREATE UNIQUE INDEX items_manual_source_key
ON items(source_provider,source_namespace,key) WHERE source = 'open-compute:manual';

INSERT INTO items
  (id,source,source_provider,source_namespace,key,status,active_generation,desired_generation,
   metadata_json,created_at_ms,updated_at_ms)
SELECT id,source,NULL,NULL,key,status,active_generation,desired_generation,
       metadata_json,created_at_ms,updated_at_ms FROM items_v1;

CREATE TABLE item_generations (
  item_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  index_generation INTEGER NOT NULL CHECK(index_generation > 0),
  state TEXT NOT NULL CHECK(state IN ('queued','claimed','chunked','completed','error','outdated','cancelled')),
  object_key TEXT,
  object_sha256 BLOB CHECK(object_sha256 IS NULL OR length(object_sha256) = 32),
  r2_object_version TEXT,
  r2_etag TEXT,
  r2_uploaded_at_ms INTEGER,
  manual_revision TEXT,
  manual_sha256 BLOB CHECK(manual_sha256 IS NULL OR length(manual_sha256) = 32),
  object_size INTEGER NOT NULL CHECK(object_size >= 0),
  content_type TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  PRIMARY KEY(item_id, generation),
  FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
  CHECK(
    (object_key IS NOT NULL AND object_sha256 IS NOT NULL
     AND r2_object_version IS NULL AND r2_etag IS NULL AND r2_uploaded_at_ms IS NULL
     AND manual_revision IS NULL AND manual_sha256 IS NULL)
    OR
    (object_key IS NULL AND object_sha256 IS NULL
     AND r2_object_version IS NOT NULL AND length(r2_object_version) > 0
     AND r2_etag IS NOT NULL AND length(r2_etag) > 0 AND r2_uploaded_at_ms IS NOT NULL
     AND manual_revision IS NULL AND manual_sha256 IS NULL)
    OR
    (object_key IS NULL AND object_sha256 IS NULL
     AND r2_object_version IS NULL AND r2_etag IS NULL AND r2_uploaded_at_ms IS NULL
     AND manual_revision IS NOT NULL AND length(manual_revision) BETWEEN 1 AND 256
     AND manual_sha256 IS NOT NULL)
  )
) STRICT;

INSERT INTO item_generations
  (item_id,generation,index_generation,state,object_key,object_sha256,r2_object_version,r2_etag,
   r2_uploaded_at_ms,manual_revision,manual_sha256,object_size,content_type,created_at_ms,completed_at_ms)
SELECT item_id,generation,index_generation,state,object_key,object_sha256,r2_object_version,r2_etag,
       r2_uploaded_at_ms,NULL,NULL,object_size,content_type,created_at_ms,completed_at_ms
FROM item_generations_v1;

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  item_generation INTEGER NOT NULL,
  index_generation INTEGER NOT NULL CHECK(index_generation > 0),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  start_byte INTEGER NOT NULL CHECK(start_byte >= 0),
  end_byte INTEGER NOT NULL CHECK(end_byte >= start_byte),
  text TEXT NOT NULL,
  embedding_f32le BLOB CHECK(embedding_f32le IS NULL OR length(embedding_f32le) % 4 = 0),
  vector_norm REAL CHECK(vector_norm IS NULL OR vector_norm > 0.0),
  metadata_json BLOB NOT NULL,
  UNIQUE(item_id, item_generation, ordinal),
  FOREIGN KEY(item_id, item_generation)
    REFERENCES item_generations(item_id, generation) ON DELETE CASCADE
) STRICT;
INSERT INTO chunks SELECT * FROM chunks_v1;
CREATE INDEX chunks_by_active_item ON chunks(item_id, item_generation, ordinal);

CREATE TABLE index_job_items (
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_generation INTEGER NOT NULL,
  index_generation INTEGER NOT NULL CHECK(index_generation > 0),
  state TEXT NOT NULL CHECK(state IN ('queued','claimed','chunked','completed','error','outdated','cancelled')),
  next_batch_ordinal INTEGER NOT NULL CHECK(next_batch_ordinal >= 0),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(job_id, item_id),
  FOREIGN KEY(job_id) REFERENCES index_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY(item_id, item_generation)
    REFERENCES item_generations(item_id, generation) ON DELETE CASCADE
) STRICT;
INSERT INTO index_job_items SELECT * FROM index_job_items_v1;

CREATE TABLE item_logs (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  action TEXT NOT NULL,
  message_code TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
) STRICT;
INSERT INTO item_logs SELECT * FROM item_logs_v1;

DROP TABLE chunks_v1;
DROP TABLE index_job_items_v1;
DROP TABLE item_logs_v1;
DROP TABLE item_generations_v1;
DROP TABLE items_v1;
