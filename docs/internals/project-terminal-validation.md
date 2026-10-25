# Project terminal validation

Implementation branch: `feat/project-checkout-terminals`.
Review baseline: `bfc31507f8483b0ba22cf10f5862947b49b20a53`.
Spec: [Project terminals](project-terminals-spec.md).

## Automated checks

- The existing server RPC harness covers concurrent opens, checkout/worktree identity, in-place branch changes, incompatible launch directories, reconnects, terminated sessions, stale generations, saved output after restart, dedicated task idempotency, unknown task outcomes, thread archive/deletion, project deletion, legacy transcripts, primary selection, and checkout-removal confirmation.
- Terminal manager, setup runner, and native PTY adapter suites: 57 tests passed. New regressions cover shutdown before output persistence, eviction before shutdown, task shells exiting before command submission, and Windows ConPTY termination.
- Contract, shared client reducer, web state/panel/context, mobile terminal helper, and PTY adapter checks: 123 tests passed. These include metadata/output bounds and environment/checkout selection isolation. The adapter tests overlap the preceding group.
- Scoped server, web, and mobile typechecks passed. Targeted lint has only two existing nested-icon warnings in CommandPalette; no new lint errors.
- An earlier full server RPC file run exposed two unrelated Windows limitations: a POSIX `/logs` suffix assertion and a symlink fixture requiring Windows privileges. The terminal/worktree RPC subset passes. No repository-wide checks were run.

## Integrated client evidence

Disposable Git main/worktree checkouts and a separate T3 home were used throughout; the live installation was not modified.

The collaborative browser pass exercised two chats in the main checkout, a third chat in a linked worktree, a harmless long-running command, thread archive, a second attached browser, and project-only terminal access. The same main-shell PID survived chat navigation/archive; the worktree used another PID and launch directory. Terminal input and persisted output were inspected.

After the collaborative preview host became unavailable, a separate headless browser checked the updated new-session flow and captured the project terminal chooser. It confirmed a distinct new-session PID, worktree isolation, a separately paired second client, reconnect without replacing the live process, termination, and selecting a remaining live session on the next explicit open. Drawer-to-panel movement was not exercised live.

Native desktop and mobile acceptance remains unverified. Android SDK/emulator launch succeeded, but no compatible T3 development client or existing APK was installed. Desktop renderer changes share the checked web implementation; no native desktop bundle was launched. Relay/tunnel and a mobile reconnect were not exercised. The requested full multi-surface acceptance is therefore not complete.

## Standards review

Parallel review found issues in root-resolution cache keys, closed-session visibility, restart launch provenance, unbounded metadata, snapshot buffer retention, shutdown persistence, primary-selection races, and failed-open feedback. Those findings were corrected and the relevant regressions/checks passed. The final narrow recheck confirmed failed-open feedback and retry; a stale-error early-return edge was subsequently corrected by clearing the error before retained-session selection.

## Spec review

Parallel review found issues in root changes, unavailable main checkouts, generation-specific removal confirmation, primary replacement, unknown task outcomes, primary attachment ordering, failed-open feedback, and rapid checkout navigation. Those findings were corrected. The final narrow recheck reported no remaining implementation findings and retained the native/relay acceptance limits above.

Review result: no known unresolved code findings on either axis; integrated native desktop/mobile and relay/tunnel coverage remains outstanding.

## Surface coverage

The implementation updates chat drawers, right-panel terminal descriptors, project/sidebar actions, the command palette, terminal keybindings, mobile home/project routes, and mobile thread routes/panels. Shared contracts and client state carry checkout ownership; desktop uses the web renderer. Provider adapters retain private execution, while project scripts and worktree setup use dedicated task sessions. User behavior and internal ownership are documented separately.
