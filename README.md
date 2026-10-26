# T4 Code

T4 Code is [Gohostieee's fork](https://github.com/Gohostieee/t3code) of [T3 Code](https://github.com/pingdotgg/t3code), with project terminals shared by checkout and a separately installed Windows desktop app. Search Windows for **T4 Code (Nightly)** to open it.

The fork follows public upstream `main` and carries the terminal changes plus T4 desktop branding and build setup.

## Install the Windows nightly

1. Open [T4 Code nightly builds](https://github.com/Gohostieee/t3code/actions/workflows/t4code-nightly.yml) and select a successful run.
2. Download its `t4code-windows-x64-...` artifact and extract the ZIP.
3. Run `T4-Code-...-x64.exe`. Reinstall a newer build to update.

Builds run on pushes to `main`, daily at **07:23 UTC**, and on demand through **Run workflow**. They are unsigned and retained as GitHub Actions artifacts for 30 days; downloading artifacts requires signing in to GitHub.

T4 installs alongside T3 with its own executable, Start menu shortcut, URL scheme, and data directories. Its server state lives in `%USERPROFILE%/.t4/userdata`; its desktop profile lives in `%APPDATA%/t4code`. Existing T3 data is not imported. There is no automatic update feed.

## Project terminals

Terminals belong to a project checkout, so threads working in the same checkout share their shells. Open **Project terminals** from the project menu or command palette to use them without a chat. Worktrees have separate sessions, and closing a thread leaves its checkout's terminals available.

See the [terminal guide](docs/user/terminals.md) for sessions, task output, restarting shells, and saved history. Update clients together with the server when using these terminal changes.

## Build and develop

Install [Vite+](https://viteplus.dev/guide/), Rust, Python, and the Visual Studio C++ build tools with the Windows SDK. Then, in PowerShell:

```powershell
git clone https://github.com/Gohostieee/t3code.git
cd t3code
vp i
./scripts/build-t4-nightly.ps1
```

The installer appears in `release/t4code`. See the [nightly build runbook](docs/operations/t4code-nightly.md) for versioning and build details.

For development:

```powershell
vp run dev --home-dir .t3
```

Open the pairing URL printed by the dev runner. See [development setup](docs/operations/development.md) and [architecture](docs/internals/overview.md) for contributor guidance.

## Upstream

T3 Code supports coding agents through their existing subscriptions and CLIs. Provider setup, remote connections, and other shared features are documented in [docs/](docs/README.md). The [upstream project](https://github.com/pingdotgg/t3code) provides the official T3 applications and releases.

T4 retains the upstream [MIT license](LICENSE) and attribution. Internal package names remain compatible with the upstream workspace.
