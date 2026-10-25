import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN analysis_json TEXT`;
  yield* sql`CREATE INDEX projection_threads_analysis ON projection_threads(project_id) WHERE analysis_json IS NOT NULL`;
});
