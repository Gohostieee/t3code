# Atlas implementation and verification

Date: 2026-10-27. Branch: `feat/source-derived-codebase-atlas`.

The source-derived atlas, feature/scenario editing, environment-owned captures, and web/native mobile interfaces are implemented. Release acceptance remains incomplete: packaged Electron, native-device, remote/relay, and idle-client verification are still outstanding. This record distinguishes implemented behavior from observed acceptance.

## Observed behavior

- Real Git/SQLite/compiler integration covers Next routes, endpoints, inherited layouts/boundaries, aliased JSX, TanStack pathless layouts and route options, deterministic repeated indexing, documentation compare-and-swap, missing references, cancellation through durable progress, malformed artifacts, mixed type/value imports, source exclusions, and parser-budget failure preserving the accepted map.
- A committed atlas and its feature/scenario definitions are exercised through a fresh checkout with no local atlas records, including `core.autocrlf=true`. Targets, sessions, jobs, and captures remain environment-local.
- A real Next 16.4.3 application and Playwright Chromium produce populated, empty, signed-out redirect, and expected HTTP-error images. The test exercises explicit browser setup, a private cookie profile, parameters, readiness, viewport dimensions, signed asset resolution, and image deletion. CSS, server content, and a client component are present in the inspected images.
- A real headless web client created a feature, assigned a route, attached the running Next fixture, imported a session, captured an authenticated page, enlarged its environment-served image, detected a source edit, refreshed the atlas, and loaded the same feature from a second browser context.
- T3's `apps/web` application produced 17 TanStack route declarations. The actual route catalog and scoped map were inspected, including the Codebase route, root/pathless layouts, route component, and error boundary.
- Web, mobile, server, and shared client-runtime typechecking and targeted lint were run. The broader focused backend regression run passed 36 tests across six Codebase/asset/authorization files. The graph layout suite passed four tests. Final staged-snapshot checks are recorded in the implementation handoff.

The standalone packed server ran successfully with its separate extraction worker. This establishes the standalone bundle path; it does not establish the Electron distribution's capture setup.

## Measurements

An isolated measurement process indexed the working T3 checkout with 2,743 inventoried files, including 847 parsed files in the selected app/dependency closure. Cold and warm extraction produced the same structural revision: 4,991 nodes, 8,758 edges, 17 routes, and 5,932,861 serialized bytes.

| Measurement                     |              Cold |              Warm |
| ------------------------------- | ----------------: | ----------------: |
| Extraction duration             |         144.173 s |          53.136 s |
| Parsing/discovery portion       |          61.603 s |           2.424 s |
| Files reparsed                  |               847 |                 0 |
| Files reused                    |                 0 |               847 |
| Peak RSS of measurement process | 574,570,496 bytes | 586,932,224 bytes |

Initial inventory took 26.337 s. The retained syntax text was 6,376,608 UTF-8 bytes, within the 8 MiB cache budget. These are measurements from this Windows session, not a cross-platform performance claim. They include a compiler/Effect measurement process, not just incremental server memory. Client/job latency is separate; a real T3 refresh-to-visible pass took 161.490 s before the final queue/inventory reuse changes. Cold indexing remains slow and needs further profiling before a broad release. Unchanged service jobs reuse accepted structure instead of repeating extraction.

Views are capped at 80 nodes, 200 edges, and 50 files/diagnostics, with explicit truncation. Source input is capped at 8 MiB and accepted structure at 32 MiB. Image limits are 8 MiB each and 256 MiB per environment. Wire-envelope byte measurements and idle-client GPU/CPU measurements remain outstanding.

## Standards review

Five findings were raised and addressed:

1. Aggregate parser retention lacked a limit. Extraction now enforces an 8 MiB source budget, retains a bounded syntax cache, and preserves accepted content on overflow. Cached checkout bindings are also bounded.
2. A destination edit during chunk writes could be overwritten. Source/head/branch and destination revision are rechecked immediately before the manifest switch.
3. Unconditional path lowercasing broke case-sensitive hosts. Compiler keys now honor the host's case-sensitivity policy.
4. Edge deduplication scanned prior edges repeatedly. A set now tracks accepted edge identities.
5. Named type-only imports lost their evidence category. Named and mixed declarations now produce the appropriate type/value relationships.

The highest-impact findings concerned resource exhaustion and destination preservation. No reported Standards finding is intentionally deferred.

## Spec review

Five findings were raised and addressed:

1. The destination-publication race above violated expected-revision preservation.
2. Orphaned scenarios and missing feature members lacked recovery controls. Setup can open saved scenarios, route selection supports reassignment, and feature editing can remove individual references.
3. Excluded oversized source could yield a false complete label. Excluded source now emits diagnostics and partial coverage.
4. TanStack route options lacked component/boundary relationships. Static component, pending, error, and not-found options now produce evidence or explicit unresolved diagnostics, including inherited boundaries.
5. Route thumbnails selected an unexplained latest image. Both clients now expose a per-route scenario selector and scenario name.

The highest-impact findings concerned destination preservation and missing-reference recovery. No reported Spec finding is intentionally deferred.

## Remaining release acceptance

- Device tools continued to report **Agent device access is turned off for this environment**, including after the developer said they would enable access. Native mobile acceptance could not run. No device-control fallback bypassed that setting.
- Packaged Windows Electron setup/capture and a real remote/relay client remain unverified. Two local browser contexts establish shared environment state, not relay transport acceptance.
- Scenario cancellation, restart reconciliation, queue saturation, cross-environment contention, and cache eviction have implementation paths but do not yet have exhaustive feature-level acceptance coverage.
- Cold/warm extraction and artifact measurements are recorded above; exact subscription/page envelopes and idle-client behavior still require measurement.

The commit includes the shared inventory and presentation prerequisites used by the atlas. Earlier automatic provider-traversal implementation and its additional tests remain separate, uncommitted working-tree changes. Isolated verification state and screenshots remain local; the developer's live T3 data was not used as a writable test target.
