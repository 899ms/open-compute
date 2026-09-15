CREATE TABLE ai_search_manual_sources (
  instance_resource_id TEXT PRIMARY KEY REFERENCES ai_search_instances(resource_id),
  provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 64),
  source_namespace TEXT NOT NULL CHECK(length(source_namespace) BETWEEN 1 AND 128),
  created_at_ms INTEGER NOT NULL
) WITHOUT ROWID, STRICT;
