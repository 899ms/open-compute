use super::*;

#[test]
fn migration_ledger_is_atomic_idempotent_and_detects_drift() {
    let fixture = fixture();
    let sql = "CREATE TABLE migrated(id INTEGER PRIMARY KEY); PRAGMA user_version = 1;";
    let migration = D1Migration {
        id: 1,
        name: "0001_init.sql".to_owned(),
        sha256: Sha256::digest(sql.as_bytes()).into(),
        sql: sql.to_owned(),
    };
    let second_sql = "ALTER TABLE migrated ADD COLUMN name TEXT; PRAGMA user_version = 2;";
    let second = D1Migration {
        id: 2,
        name: "0002_name.sql".to_owned(),
        sha256: Sha256::digest(second_sql.as_bytes()).into(),
        sql: second_sql.to_owned(),
    };
    let chain = [migration.clone(), second];
    let first = fixture
        .engine
        .apply_migrations(std::slice::from_ref(&migration), limits(), 101)
        .unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(fixture.engine.session_version().unwrap(), 1);
    assert_eq!(fixture.engine.user_version().unwrap(), 1);
    assert_eq!(
        fixture
            .engine
            .apply_migrations(std::slice::from_ref(&migration), limits(), 202)
            .unwrap(),
        first
    );
    assert_eq!(fixture.engine.session_version().unwrap(), 1);
    let applied = fixture
        .engine
        .apply_migrations(&chain, limits(), 250)
        .unwrap();
    assert_eq!(applied.len(), 2);
    assert_eq!(fixture.engine.user_version().unwrap(), 2);
    assert_eq!(
        fixture
            .engine
            .apply_migrations(std::slice::from_ref(&migration), limits(), 251)
            .unwrap_err()
            .code(),
        ErrorCode::D1MigrationDrift,
    );
    let mut drift = migration;
    drift.sql = "CREATE TABLE different(id INTEGER)".to_owned();
    drift.sha256 = Sha256::digest(drift.sql.as_bytes()).into();
    assert_eq!(
        fixture
            .engine
            .apply_migrations(&[drift], limits(), 303)
            .unwrap_err()
            .code(),
        ErrorCode::D1MigrationDrift,
    );
}
