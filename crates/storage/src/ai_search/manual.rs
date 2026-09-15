//! Explicit generation-fenced manual source mutations.

use super::*;
use uuid::Uuid;

type CurrentManualGeneration = (String, i64, String, Vec<u8>, i64, String, Vec<u8>);

/// Exact provider-owned revision admitted for indexing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NewAiSearchManualGeneration<'a> {
    /// Operator provider identity.
    pub provider_id: &'a str,
    /// Frozen provider source namespace.
    pub source: &'a str,
    /// Application-owned key.
    pub key: &'a str,
    /// Exact immutable revision.
    pub revision: &'a str,
    /// Verified content SHA-256.
    pub sha256: [u8; 32],
    /// Exact content length.
    pub object_size: u64,
    /// Canonical content type.
    pub content_type: &'a str,
    /// Canonical metadata JSON object.
    pub metadata_json: &'a [u8],
    /// Mutation timestamp.
    pub now_ms: i64,
}

/// Result of an idempotent manual exact-revision upsert.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AiSearchManualUpsert {
    /// Stable item identity.
    pub item_id: String,
    /// New indexing job, absent when the exact revision was already desired.
    pub job_id: Option<String>,
}

impl AiSearchStore {
    /// Queue exactly one provider-owned revision without persisting its source bytes.
    pub fn upsert_manual_generation(
        &self,
        input: &NewAiSearchManualGeneration<'_>,
    ) -> Result<AiSearchManualUpsert, PlatformError> {
        validate_manual(input)?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let current: Option<CurrentManualGeneration> = transaction
            .query_row(
                "SELECT i.id, i.desired_generation, g.manual_revision, g.manual_sha256,
                        g.object_size, g.content_type, i.metadata_json
                   FROM items i JOIN item_generations g
                     ON g.item_id=i.id AND g.generation=i.desired_generation
                  WHERE i.source='open-compute:manual' AND i.source_provider=?1
                    AND i.source_namespace=?2 AND i.key=?3",
                params![input.provider_id, input.source, input.key],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()
            .map_err(sql_error)?;
        if let Some((item_id, _, revision, sha256, size, content_type, metadata_json)) = &current
            && revision == input.revision
            && sha256.as_slice() == input.sha256
            && *size == to_i64(input.object_size)?
            && content_type == input.content_type
            && metadata_json == input.metadata_json
        {
            transaction.commit().map_err(sql_error)?;
            return Ok(AiSearchManualUpsert {
                item_id: item_id.clone(),
                job_id: None,
            });
        }
        enforce_enqueue_quotas(
            &transaction,
            "open-compute:manual",
            Some(input.provider_id),
            Some(input.source),
            input.key,
            input.object_size,
        )?;
        prune_terminal_jobs(&transaction)?;
        let config_generation: i64 = transaction
            .query_row(
                "SELECT config_generation FROM instance_meta WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        let index_generation: i64 = transaction
            .query_row(
                "SELECT active_index_generation FROM instance_meta WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        let item_id = current.as_ref().map_or_else(
            || {
                let mut digest = Sha256::new();
                for value in [input.provider_id, input.source, input.key] {
                    digest.update(value.as_bytes());
                    digest.update([0]);
                }
                hex::encode(digest.finalize())
            },
            |value| value.0.clone(),
        );
        let generation = current.as_ref().map_or(Ok(1), |value| {
            value.1.checked_add(1).ok_or_else(limit_error)
        })?;
        let job_id = Uuid::now_v7().to_string();
        transaction
            .execute(
                "INSERT INTO index_jobs
             (id,source,state,config_generation,index_generation,attempt,next_attempt_at_ms,
              cancel_requested,created_at_ms,updated_at_ms)
             VALUES (?1,'user','queued',?2,?3,0,?4,0,?4,?4)",
                params![job_id, config_generation, index_generation, input.now_ms],
            )
            .map_err(sql_error)?;
        transaction
            .execute(
                "INSERT INTO items
             (id,source,source_provider,source_namespace,key,status,desired_generation,
              metadata_json,created_at_ms,updated_at_ms)
             VALUES (?1,'open-compute:manual',?2,?3,?4,'queued',?5,?6,?7,?7)
             ON CONFLICT(source_provider,source_namespace,key) WHERE source='open-compute:manual'
             DO UPDATE SET status='queued',desired_generation=excluded.desired_generation,
               metadata_json=excluded.metadata_json,updated_at_ms=excluded.updated_at_ms",
                params![
                    item_id,
                    input.provider_id,
                    input.source,
                    input.key,
                    generation,
                    input.metadata_json,
                    input.now_ms
                ],
            )
            .map_err(sql_error)?;
        transaction
            .execute(
                "INSERT INTO item_generations
             (item_id,generation,index_generation,state,manual_revision,manual_sha256,
              object_size,content_type,created_at_ms)
             VALUES (?1,?2,?3,'queued',?4,?5,?6,?7,?8)",
                params![
                    item_id,
                    generation,
                    index_generation,
                    input.revision,
                    input.sha256,
                    to_i64(input.object_size)?,
                    input.content_type,
                    input.now_ms
                ],
            )
            .map_err(sql_error)?;
        transaction.execute(
            "INSERT INTO index_job_items
             (job_id,item_id,item_generation,index_generation,state,next_batch_ordinal,updated_at_ms)
             VALUES (?1,?2,?3,?4,'queued',0,?5)",
            params![job_id, item_id, generation, index_generation, input.now_ms],
        ).map_err(sql_error)?;
        append_item_log(&transaction, &item_id, "queued", input.now_ms)?;
        append_job_log(&transaction, &job_id, "queued", 0, input.now_ms)?;
        prune_generation_history(&transaction)?;
        transaction.commit().map_err(sql_error)?;
        Ok(AiSearchManualUpsert {
            item_id,
            job_id: Some(job_id),
        })
    }
}

fn validate_manual(input: &NewAiSearchManualGeneration<'_>) -> Result<(), PlatformError> {
    if input.provider_id.is_empty()
        || input.provider_id.len() > 64
        || input.source.is_empty()
        || input.source.len() > 128
        || input.key.is_empty()
        || input.key.len() > 1024
        || input.revision.is_empty()
        || input.revision.len() > 256
        || input.object_size == 0
        || input.object_size > 64 * 1024 * 1024
        || input.content_type.is_empty()
        || input.content_type.len() > 256
        || [
            input.provider_id,
            input.source,
            input.key,
            input.revision,
            input.content_type,
        ]
        .iter()
        .any(|value| value.chars().any(char::is_control))
        || !canonical_json_object(input.metadata_json, 65_536)
    {
        return Err(limit_error());
    }
    Ok(())
}
