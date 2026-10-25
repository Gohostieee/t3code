# Codebase explorer operations

Use an isolated T3 home and a separate source checkout for acceptance. Never start a test server against the live userdata directory. Obtain explicit permission for browser tests and name the configured provider used for paid analysis.

For a pass that does not complete, inspect Analysis activity and its transcript first. `queued` is waiting behind another checkout-local attempt. `running` is provider work. `waiting` identifies a pending provider request. `validating` checks the final structured result; `saving` is the acceptance boundary. A successful provider turn alone is not a successful map pass.

Invalid output remains in the runtime transcript. No automatic repair pass runs. An `input-changed` attempt indicates changed source, branch/HEAD, configuration, parent, or destination revision. Inspect current files and retry explicitly. Do not restore old files to make the attempt succeed.

Portable files are `.t3-codebase/manifest.json` and `.t3-codebase/scopes/<scope-id>.json`. Runtime metadata is in the analysis thread's events and `projection_threads.analysis_json`; the database is not the accepted-map source of truth. A map copy needs source and artifact files, not provider sessions or database rows.

The Git administrative directory contains the cooperating-write lock, `t3-codebase-write.lock`. A live owner causes a retryable busy error. After five minutes a dead owner is recoverable by the next writer. The recovery path probes process existence; it never kills the recorded PID. Do not delete a lock belonging to a live writer.

Test with one overview, at least one detail pass, connection/source inspection, cancellation, reconnect, and another clone containing committed map files. Record the actual provider instance/model/options, source revision, tested clients, and remaining gaps separately from deterministic test results. Do not advertise an adapter as supported without a live smoke pass and enforceable inspection permissions.
