import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE codebase_atlas_jobs (id TEXT PRIMARY KEY, checkout TEXT NOT NULL, app_root TEXT NOT NULL, command_id TEXT NOT NULL, input_hash TEXT NOT NULL, input_json TEXT NOT NULL, state_json TEXT NOT NULL, UNIQUE(checkout, app_root, command_id))`;
  yield* sql`CREATE INDEX codebase_atlas_jobs_checkout ON codebase_atlas_jobs(checkout, app_root)`;
  yield* sql`CREATE TABLE codebase_atlas_local (checkout TEXT NOT NULL, app_root TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(checkout, app_root, key))`;
});
