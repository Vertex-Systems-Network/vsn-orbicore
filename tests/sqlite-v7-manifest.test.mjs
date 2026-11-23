import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { assertSupportedSqliteV7Manifest, SQLITE_V7_MIGRATIONS, validateSqliteV7Manifest } from "../apps/api/sqlite-v7-manifest.mjs";

const time = "2026-11-23T09:00:00.000Z";
const valid = () => SQLITE_V7_MIGRATIONS.map((name,index)=>({version:index+1,name,applied_at:time}));

test("ORB-005/017 exact source lineage accepts only the seven known SQLite v7 entries", () => {
  assert.deepEqual(validateSqliteV7Manifest(valid()),{supported:true,version:7,count:7});
  for (const edit of [
    rows => rows.pop(),
    rows => rows.push({version:8,name:"future",applied_at:time}),
    rows => { rows[0].version = 2; },
    rows => { rows[6].name = "missing_secret_migration"; },
    rows => { rows[3].applied_at = "unknown"; },
    rows => { rows[3].applied_at = null; },
  ]) {
    const rows=valid();edit(rows);
    assert.throws(()=>validateSqliteV7Manifest(rows),/sqlite_v7_migration_manifest_mismatch/);
  }
});

test("ORB-005/017 source SQLite preflight validates records before any PG contact", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
    const statement = db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)");
    for(let i=0;i<SQLITE_V7_MIGRATIONS.length;i++)statement.run(i+1,SQLITE_V7_MIGRATIONS[i],time);
    assert.equal(assertSupportedSqliteV7Manifest(db).version,7);
    db.prepare("UPDATE schema_migrations SET applied_at='broken' WHERE version=7").run();
    assert.throws(()=>assertSupportedSqliteV7Manifest(db),/sqlite_v7_migration_manifest_mismatch/);
  } finally {db.close();}
});
