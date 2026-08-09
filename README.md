# SoundCloud Downloader

Desktop app (ElectroBun) to download music from SoundCloud in high quality using **yt-dlp** and **ffmpeg**. Download your favorites ("likes"), playlists and individual tracks as MP3 320 kbps and other formats, with an integrated SoundCloud session (your credentials are never exposed to the app).

[![Build & Publish](https://github.com/mikelgmh/soundcloud-dl/actions/workflows/release-build.yml/badge.svg)](https://github.com/mikelgmh/soundcloud-dl/actions/workflows/release-build.yml)
[![Release](https://github.com/mikelgmh/soundcloud-dl/actions/workflows/release.yml/badge.svg)](https://github.com/mikelgmh/soundcloud-dl/actions/workflows/release.yml)
[![Tests](https://github.com/mikelgmh/soundcloud-dl/actions/workflows/tests.yml/badge.svg)](https://github.com/mikelgmh/soundcloud-dl/actions/workflows/tests.yml)
[![Coverage](https://codecov.io/gh/mikelgmh/soundcloud-dl/branch/main/graph/badge.svg)](https://codecov.io/gh/mikelgmh/soundcloud-dl)
[![Version](https://img.shields.io/github/v/release/mikelgmh/soundcloud-dl)](https://github.com/mikelgmh/soundcloud-dl/releases/latest)
[![Release date](https://img.shields.io/github/release-date/mikelgmh/soundcloud-dl)](https://github.com/mikelgmh/soundcloud-dl/releases/latest)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-4a90d9)](https://github.com/mikelgmh/soundcloud-dl/releases/latest)
[![Bun](https://img.shields.io/badge/Bun-1.x-000000?logo=bun)](https://bun.sh)

> Coverage is measured in GitHub Actions (`bun test --coverage`) and uploaded to
> [Codecov](https://codecov.io/gh/mikelgmh/soundcloud-dl). If the badge does not
> show, check that the Codecov integration is enabled for the repository.

## Download

Download the installer for your operating system (latest release):

[![Download macOS (Apple Silicon)](https://img.shields.io/badge/Download%20macOS%20(Apple%20Silicon)-007AFF?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/mikelgmh/soundcloud-dl/releases/latest/download/stable-macos-arm64-SoundCloudDownloader.dmg)
[![Download Windows](https://img.shields.io/badge/Download%20Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/mikelgmh/soundcloud-dl/releases/latest/download/stable-win-x64-SoundCloudDownloader-Setup.exe)
[![Download Linux](https://img.shields.io/badge/Download%20Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)](https://github.com/mikelgmh/soundcloud-dl/releases/latest/download/stable-linux-x64-SoundCloudDownloader-Setup.tar.gz)

- **macOS Intel (x64)**: not published because GitHub Actions no longer offers Intel runners. Compile it locally on an Intel Mac with `bun run build:mac:intel` (see below).
- The Windows download is a single-file `.exe` installer (built with Inno Setup). It installs the app per-user (no admin rights required), adds a Start Menu shortcut, an uninstaller and an entry in "Add or remove programs".
- Alternative installers (`.tar.zst`, update bundles) and every version are on [GitHub Releases](https://github.com/mikelgmh/soundcloud-dl/releases).

## Features

- **Download favorites, playlists and use global search** on SoundCloud from inside the app.
- **Configurable format and quality**: `mp3`, `m4a`, `opus`, `flac`, `wav`, `vorbis` and `original`, with configurable bitrate (320K, 192K...).
- **File name template** with chips (Title, Uploader, ID...), e.g. `%(title)s - %(artist)s`.
- **Sign in to SoundCloud** via the native system webview (no token stored in plain text long-term); the session is kept as an `oauth_token` cookie.
- **Anti-bot**: strictly sequential, serialized downloads, no parallelism.
- **Download queue** with pause/resume/stop, per-track progress (%, ETA, speed), history and a per-track "Downloaded" state.
- **Global SoundCloud search** (`scsearch20:`) and filter inside your collection.
- **Auto-update** in stable builds (installer + `tar.zst` + `update.json` on GitHub Releases).
- **Integrated dependency management**: install/update yt-dlp and ffmpeg from inside the app.
- **Light/dark theme**, output folder picker, config export/import.

## Requirements

- [Bun](https://bun.sh) >= 1.2 (for development and building).
- Node.js is not required.

## Development

```bash
bun install
bun run dev          # starts the app in development mode with hot reload
bun run build:css    # compiles Tailwind (input.css -> index.css)
```

## Build

```bash
bun run build:stable   # production build ("stable" channel)
bun run build:canary   # production build ("canary" channel)
```

ElectroBun builds **for the host system** (host OS + architecture). There is no cross-compilation: to produce the macOS Apple Silicon installer you need an ARM Mac, for Windows a Windows machine, etc.

### Windows installer (.exe)

After a stable build on Windows, a single-file `.exe` installer is produced with Inno Setup:

```bash
bun run build:windows   # = bun run build:stable && bun run build:win:installer
bun run build:win:installer   # just the installer, from an existing build
```

- Requires [Inno Setup 6](https://jrsoftware.org/isinfo.php) (`choco install innosetup -y`).
- The script compiles `scripts/windows/installer.iss`, which installs the app to `%LOCALAPPDATA%\dev.soundcloud.downloader\stable\app` — the same location the electrobun auto-updater expects, so the app can self-update in place. Do **not** move the install folder to Program Files, or auto-updates will break.
- It replaces the electrobun `-Setup.zip` wrapper in `artifacts/`.

### Artifacts per OS

Each production build generates these files in `artifacts/`:

| File | What it is |
|---|---|
| `stable-<os>-<arch>-<App>.dmg` / `-Setup.exe` / `-Setup.tar.gz` | The app **installer** |
| `stable-<os>-<arch>-<App>.tar.zst` | The compressed app, what the **auto-updater** downloads |
| `stable-<os>-<arch>-update.json` | Version manifest consulted by the auto-updater |
| `stable-<os>-<arch>-<hash>.patch` | Differential for delta updates (from the 2nd release onward) |

> There is one installer per OS. The other files (`tar.zst` + `update.json`) are the **auto-update** mechanism: the app polls `release.baseUrl` and downloads the `tar.zst`. If they are removed, auto-updates stop working.

### Building macOS for Intel (x64) locally

GitHub Actions no longer offers macOS Intel runners, so the pipeline does not produce a `macos-x64` installer. To produce it manually on an **Intel Mac**:

```bash
bun install
bun run build:mac:intel   # = bun run build:stable
```

On an Intel Mac the build produces the `stable-macos-x64-*` artifacts in `artifacts/`. Then upload them to a GitHub release as assets (or to any host compatible with `release.baseUrl`).

## Project structure

```
electrobun.config.ts        # app configuration (name, views, release.baseUrl)
scripts/
├── prebuild.ts             # compiles Tailwind before each electrobun build
├── build-windows-installer.ts  # compiles the .exe installer with Inno Setup
└── windows/installer.iss   # Inno Setup script for the Windows installer
src/
├── bun/                    # main process (Bun runtime)
│   ├── index.ts            # window, menu, RPC, auto-update
│   ├── service.ts          # business logic and RPC handlers
│   └── login.ts            # login with the native SoundCloud webview
├── mainview/               # main app view (HTML + TS + Tailwind)
│   ├── index.html          # 6 views: Home, Downloads, Search, Collection, Settings, Developer
│   ├── index.ts            # UI: queue, search, ETA odometer, progress
│   └── input.css           # Tailwind v4
├── connecting/             # "Connecting..." page during login
├── shared/types.ts         # shared typed RPC schema (AppRPCSchema)
├── cli.ts                  # download CLI (bun run cli)
├── auth.ts                 # CLI login (Playwright)
├── deps.ts                 # yt-dlp / ffmpeg installation
├── download.ts             # argument building and download with yt-dlp
├── store.ts                # config, cookies, likes cache, history
└── util.ts                 # runStream + pause control (SIGSTOP/SIGCONT)
```

## Architecture

- **ElectroBun** packages the app with a native Bun runtime and a webview (`Electroview`/`BrowserView`).
- The **main** process (`src/bun`) runs yt-dlp and manages the session and configuration.
- The **view** (`src/mainview`) talks to the main process through the typed RPC defined in `src/shared/types.ts` (handlers `requests` + `status`/`log`/`downloadProgress` messages).
- **Pause/resume** is implemented by sending `SIGSTOP`/`SIGCONT` to the yt-dlp process (`child.kill`); **stop** sends `SIGKILL`.
- **Anti-bot**: each download is sequential (`downloadChain` in the service + queue in the UI). No parallelism avoids SoundCloud blocks.

## SoundCloud session

- **From the app**: opens a window with the native webview loading `soundcloud.com`, you sign in and the app captures the `oauth_token` cookie, stored with `0600` permissions in the data directory.
- **From the CLI**: `bun run cli` opens a login with Playwright (stealth) and saves the token.
- The `oauth_token` is passed to yt-dlp as a Netscape cookie file to authenticate downloads.

## Dependencies (yt-dlp / ffmpeg)

- Downloaded to `bin/` inside the app data directory, or the system versions are used if present.
- The app checks versions, notifies about updates and lets you install them from the Settings / Developer view.

## Release pipeline (GitHub Actions)

| Workflow | What it does |
|---|---|
| `.github/workflows/release.yml` | On push to `main`: computes the next semantic version, creates the `v<version>` tag and triggers the build. |
| `.github/workflows/release-build.yml` | Build matrix: `macos-arm64` (macos-14), `windows-x64` (windows-latest), `linux-x64` (ubuntu-latest). Uploads all artifacts and publishes the release with `softprops/action-gh-release`. On Windows it also installs Inno Setup and builds the `.exe` installer. |

Notes:

- Conventional commits (`feat:`, `fix:`, `chore:`) determine the bump (major/minor/patch).
- **No macOS Intel build** because GitHub retired the Intel runners; Apple Silicon only. See "Building macOS for Intel" above.
- Artifacts are published on GitHub Releases; the `baseUrl` for auto-update points to `releases/latest/download`.

## CLI

The project keeps an independent CLI in `src/cli.ts`:

```bash
bun run cli                          # interactive wizard (setup + favorites download)
bun run cli --setup                  # re-run the wizard
bun run cli --search "term"          # search and download
bun run cli --yes --token <t> --username <u> --outdir <dir>   # non-interactive
```

## Scripts

| Command | Description |
|---|---|
| `bun run dev` | App in development with hot reload |
| `bun run build:stable` | Stable production build |
| `bun run build:canary` | Canary production build |
| `bun run build:mac:intel` | Stable build (to produce `macos-x64` on an Intel Mac) |
| `bun run build:win:installer` | Build the Windows `.exe` installer with Inno Setup |
| `bun run build:windows` | Windows stable build + `.exe` installer |
| `bun run build:css` | Compile Tailwind |
| `bun run cli` | Download CLI |
