# T4 Code nightly on Windows

The `main` branch of [Gohostieee/t3code](https://github.com/Gohostieee/t3code) contains the checkout-owned terminal changes on public upstream main. The Windows application is named **T4 Code (Nightly)**, with `t4code.exe` and its own Start menu shortcut.

## Scheduled builds on the Windows build PC

Use a dedicated checkout with no uncommitted changes and sign in to GitHub CLI as the Windows user who will run the task. Install its dependencies with `vp i`, then register the task:

```powershell
./scripts/install-t4-nightly-task.ps1
Start-ScheduledTask -TaskName 'T4 Code Nightly'
```

The task runs daily at **03:23 in the PC's local time zone**. Supply `-At "04:00"` when registering to change the time. It runs with the signed-in user's normal privileges, opens no window, catches up on missed starts when available, and skips overlapping task runs. The PC must be on and the user must be signed in; it does not store a Windows password or wake the PC.

Each run fast-forwards the dedicated checkout to the fork's `main`, builds Windows x64, and publishes a GitHub prerelease. It reuses the verified dependency install while the lockfile, manifests, install configuration, and patches are unchanged; changed inputs trigger a frozen install. The recorded install commit advances only after installation succeeds. It refuses dirty or diverged checkouts. GitHub CLI supplies credentials from the Windows user's existing login; no credentials are stored in the task or repository. The task records tool locations in the checkout's gitignored `.t3/nightly/tool-paths.json` so it also works without a shell profile.

Inspect progress in `.t3/nightly/logs` and inspect the scheduler result with:

```powershell
Get-ScheduledTask -TaskName 'T4 Code Nightly'
Get-ScheduledTaskInfo -TaskName 'T4 Code Nightly'
```

A successful task returns `LastTaskResult` 0. The newest local installer and the last 30 build logs are retained. Published releases remain on GitHub. Disable the task with `Disable-ScheduledTask`, enable it with `Enable-ScheduledTask`, or remove the schedule with `Unregister-ScheduledTask -TaskName 'T4 Code Nightly' -Confirm:$false`.

## Downloads and updates

Download the Windows x64 installer from the newest **T4 Code Nightly** prerelease on the [releases page](https://github.com/Gohostieee/t3code/releases). Each version has its own release tag, installer, differential-update blockmap, `nightly.yml` update feed, `SHA256SUMS.txt`, and `SOURCE.txt` recording the exact source commit. The release is published only after all files have uploaded. Workflow artifacts are also retained for 30 days as a fallback.

T4 installs default to the Nightly update channel and check this fork's releases for updates. The build script explicitly configures `T4CODE_DESKTOP_UPDATE_REPOSITORY=Gohostieee/t3code`; the upstream `GITHUB_REPOSITORY` value never selects the T4 update feed. Preview builds keep updates disabled.

The [optional T4 Code nightly workflow](https://github.com/Gohostieee/t3code/actions/workflows/t4code-nightly.yml) provides the same release flow through **Run workflow** on GitHub-hosted Windows runners. It needs no signing or publishing secrets. Hosted builds are manual so the PC schedule does not also trigger failed hosted jobs while the account has a billing lock. The fork's Windows workflow is separate from upstream's release and CI infrastructure.

## Local builds

Build from this checkout after installing dependencies with `vp i`:

```powershell
./scripts/build-t4-nightly.ps1
```

The command builds the Rust resource helper with the installed MSVC toolchain, then uses the packaging pipeline's cached-helper path. Rust, the x64 MSVC tools, Windows SDK, and Python must be installed.

The installer, update feed, source record, and checksums are written to `release/t4code`. Run the installer to install or replace the previous T4 nightly. An explicit version can be supplied with `-Version 0.1.2-nightly.20261025.1`. Both local and GitHub builds use the UTC date and whole seconds since midnight, so their versions sort in build order.

To publish a local fallback build, commit and push its source first. Create a draft GitHub prerelease tagged `v<version>` at that exact commit, upload the installer, blockmap, `nightly.yml`, `SOURCE.txt`, and `SHA256SUMS.txt`, then publish the draft. Keep the standard `v<version>` tag format so the desktop updater can parse it. Do not mark prereleases as the latest stable release.

## Build failures

Open the Windows job's annotations if a run fails without executing any steps. An account billing lock prevents GitHub Actions from starting; changing the runner or rerunning the workflow does not clear it. Resolve the account issue in [GitHub billing settings](https://github.com/settings/billing), then run the workflow again. A locally built prerelease can supply the installer while hosted builds are blocked.

## Installation and state

T4 stores server data in `%USERPROFILE%/.t4/userdata` and its Electron profile in `%APPDATA%/t4code`. `T4CODE_HOME` overrides its server base directory. Existing T3 data is not imported. The bundled launcher is `%USERPROFILE%/.t4/bin/t4code.cmd`.

The application uses its own app ID and `t4code` URL scheme. Builds are unsigned. The local build command packages and validates the installer; publishing it remotely is a separate step.
