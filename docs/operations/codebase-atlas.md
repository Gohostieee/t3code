# Atlas capture setup and acceptance

Indexing needs no browser or running application. Capture requires an already-running HTTP application reachable from the T3 server environment and Chromium matching the pinned `playwright-core` version.

Use **Preview setup and activity → Set up capture browser**. This explicit job runs the installed Playwright CLI with `install chromium`. It does not run package-manager scripts from the indexed application. A failed download leaves indexing usable. Linux hosts may need Chromium system dependencies installed by their administrator. Do not point verification servers at live T3 userdata.

Attach the target origin and optional prefix, import an optional Playwright storage-state JSON profile, and save a scenario with concrete parameters and visible-text or locator readiness. A target is user-confirmed and source-unverified. A missing profile in a new environment requires import; credentials are never reconstructed from portable files.

Focused backend verification from `apps/server`:

```powershell
vp test run integration/codebase-atlas.integration.test.ts
$env:T3_ATLAS_RUNTIME_ACCEPTANCE = '1'
vp test run integration/codebase-atlas-runtime.integration.test.ts
```

The runtime fixture starts its own real Next application and closes only its captured child process. It validates styled server/client content, populated/empty states, authenticated and signed-out states, an expected error, viewport PNG dimensions, signed asset resolution, and deletion. Set `T3_ATLAS_EVIDENCE_DIR` to retain its screenshots and receipt. These tests do not establish packaged native client, relay, or physical-device behavior.

For release acceptance, use isolated T3 state and inspect a real client after integrating. Verify index → feature membership → attach/session → scenario capture → image delivery → source edit/refresh → second client. Exercise T3's TanStack routes too. Record cold/warm durations, memory, artifact sizes, bounded query/subscription sizes, and idle client behavior. Separately verify Windows Electron browser setup, native mobile lists/images, and a remote/relay environment. Keep incomplete gates explicit in the acceptance record.

If an atlas manifest or chunk is damaged, preserve it for review. Restore it from Git or move only that application's atlas directory aside, then explicitly index. Invalid documentation must be repaired before edits can be saved. No automatic repair or replacement is performed.
