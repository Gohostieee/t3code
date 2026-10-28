# Source-derived Codebase Atlas

The atlas extends the existing Codebase destination and checkout resolver. It uses `codebase.atlasRead` for read-scoped queries and `codebase.atlas` for operate-scoped commands. Both use shared contracts and client atoms. Source extraction and capture run in the environment; clients receive bounded views and signed asset URLs resolved against that environment.

## Boundaries

- `AtlasExtractor` parses JS/TS with the pinned TypeScript compiler and resolves static modules and JSX symbols. Framework rules add Next App Router and TanStack file-route declarations. Unsupported and unresolved relationships remain diagnostics. Source inventory is independent of legacy JSON validity and provider bundle limits.
- `AtlasWorker` owns compiler work outside the server event loop. One retained worker per service reuses a syntax cache bounded to 8 MiB of source text; configuration, package, lockfile, checkout, and framework changes invalidate it. Dependencies are resolved again on changed input. Cancellation terminates only this worker.
- `AtlasStorage` writes content-addressed immutable chunks before switching one manifest pointer under the existing checkout lock. Source, branch, head, and expected-revision checks prevent stale publication. The accepted structural document is limited to 32 MiB, each file to 512 KiB. User features and scenarios use a separate compare-and-swap document.
- `CodebaseAtlas` owns durable SQLite jobs, bounded queuing, command idempotency, cancellation, recovery, private settings, captures, and paged reads. Equivalent active index commands attach. Different commands queue. Restart reconciles an already-published revision and marks other active jobs interrupted without repeating work.
- `AtlasCaptureRunner` uses pinned Playwright Chromium with a browser per batch and isolated context per scenario. Navigation waits for DOM content and a user-declared visible condition. It never starts an application, runs setup scripts, or automates user preview tabs.

Next App Router coverage includes page/endpoint conventions, groups, dynamic segments, inherited layouts/boundaries, slots, defaults, and interception declarations. Hard navigation does not exercise intercepted soft-navigation state. TanStack support covers the file-route declarations and generated-route cross-check used by T3. Next Pages Router and arbitrary code-defined route construction receive generic views with diagnostics.

Portable structural facts have semantic IDs, source ranges/fingerprints, evidence categories, and rule identifiers. Imports, re-exports, type dependencies, JSX composition, and framework relationships remain distinguishable. No call graph, runtime DOM mapping, or inferred business features are claimed.

## State and resource limits

Portable files live below `.t3-codebase/atlas/<application hash>`. Local jobs, origins, profiles, private values, and capture receipts use the environment database. Screenshots live in the environment cache and use signed asset claims; neither image bytes nor secrets cross progress subscriptions. Images are limited to one 1440×900 or 390×844 viewport, 8 MiB each, with a 256 MiB environment cache. Missing images remain unavailable metadata and can be recaptured.

Views return at most 80 nodes, 200 edges, 50 files or diagnostics, 50 jobs, and 100 capture receipts. Truncation is explicit. Inspecting a feature member by ID works outside the current page. Search and focus may reuse a bounded accepted-document cache and report freshness unknown; ordinary overview reads re-inventory source. Watch notifications trigger refresh, never establish freshness by themselves.

The web canvas uses deterministic, responsive layout without continuous animation. Native mobile uses lists, relationship details, and modal forms. Desktop wraps the same web client and uses shared native-control insets. Providers are not part of the extraction or capture path; legacy provider integrations remain available to historical APIs, with accepted maps read-only in the new destination.

## Validation

The approved integration seam is `integration/codebase-atlas.integration.test.ts`, with real Git, SQLite, source compiler fixtures, publication, documentation, cancellation, and durable progress. `integration/codebase-atlas-runtime.integration.test.ts` is an opt-in real Next/Chromium flow; it asserts actual images and signed environment asset resolution. It is enabled with `T3_ATLAS_RUNTIME_ACCEPTANCE=1`.

See the [capture runbook](../operations/codebase-atlas.md) for setup and evidence boundaries. The [MVP spec](codebase-atlas-mvp-spec.md) defines release gates; implementation and focused checks alone do not establish native desktop/mobile or relay acceptance.
