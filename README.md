# SoundCloud Downloader

App de escritorio (ElectroBun) para descargar música de SoundCloud en alta calidad usando **yt-dlp** y **ffmpeg**. Descarga tus favoritos ("me gusta"), playlists y canciones sueltas en MP3 320 kbps y otros formatos, con sesión de SoundCloud integrada (sin exponer tus credenciales a la app).

[![Build & Publish](https://github.com/mikelgmh/soundcloud-dl/actions/workflows/release-build.yml/badge.svg)](https://github.com/mikelgmh/soundcloud-dl/actions/workflows/release-build.yml)
[![Release](https://github.com/mikelgmh/soundcloud-dl/actions/workflows/release.yml/badge.svg)](https://github.com/mikelgmh/soundcloud-dl/actions/workflows/release.yml)
[![Versión](https://img.shields.io/github/v/release/mikelgmh/soundcloud-dl)](https://github.com/mikelgmh/soundcloud-dl/releases/latest)
[![Fecha del release](https://img.shields.io/github/release-date/mikelgmh/soundcloud-dl)](https://github.com/mikelgmh/soundcloud-dl/releases/latest)
[![Plataformas](https://img.shields.io/badge/plataformas-macOS%20%7C%20Windows%20%7C%20Linux-4a90d9)](https://github.com/mikelgmh/soundcloud-dl/releases/latest)
[![Bun](https://img.shields.io/badge/Bun-1.x-000000?logo=bun)](https://bun.sh)

> Nota: el proyecto no tiene suite de tests, así que no hay badge de coverage.

## Descargar

Descarga el instalador para tu sistema operativo (última versión):

[![Descargar macOS (Apple Silicon)](https://img.shields.io/badge/Descargar%20macOS%20(Apple%20Silicon)-007AFF?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/mikelgmh/soundcloud-dl/releases/latest/download/stable-macos-arm64-SoundCloudDownloader.dmg)
[![Descargar Windows](https://img.shields.io/badge/Descargar%20Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/mikelgmh/soundcloud-dl/releases/latest/download/stable-win-x64-SoundCloudDownloader-Setup.zip)
[![Descargar Linux](https://img.shields.io/badge/Descargar%20Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)](https://github.com/mikelgmh/soundcloud-dl/releases/latest/download/stable-linux-x64-SoundCloudDownloader-Setup.tar.gz)

- **macOS Intel (x64)**: no se publica porque GitHub Actions ya no ofrece runners Intel. Compílalo localmente con `bun run build:mac:intel` en un Mac Intel (ver más abajo).
- Instaladores alternativos (`.tar.zst`, updates) y todas las versiones en [GitHub Releases](https://github.com/mikelgmh/soundcloud-dl/releases).

## Funcionalidades

- **Descarga de favoritos, playlists y búsqueda global** de SoundCloud desde la propia app.
- **Formato y calidad configurables**: `mp3`, `m4a`, `opus`, `flac`, `wav`, `vorbis` y `original`, con bitrate configurable (320K, 192K...).
- **Plantilla de nombre de archivo** con chips (Título, Subidor, ID...), p. ej. `%(title)s - %(artist)s`.
- **Inicio de sesión en SoundCloud** mediante webview nativa del sistema (sin token en texto plano de forma permanente); la sesión se guarda como cookie `oauth_token`.
- **Anti-bot**: descargas estrictamente secuenciales y serializadas, sin paralelismo.
- **Cola de descargas** con pausar/reanudar/detener, progreso por canción (%, ETA, velocidad), historial y estado de "Descargada" por canción.
- **Búsqueda global en SoundCloud** (`scsearch20:`) y filtro dentro de la colección.
- **Auto-actualización** de la app en builds estables (instalador + tar.zst + `update.json` en GitHub Releases).
- **Gestión de dependencias integrada**: instala/actualiza yt-dlp y ffmpeg desde la propia app.
- **Tema claro/oscuro**, selector de carpeta de salida, exportación/importación de configuración.

## Requisitos

- [Bun](https://bun.sh) >= 1.2 (para desarrollo y build).
- Node.js no es necesario.

## Desarrollo

```bash
bun install
bun run dev          # arranca la app en modo desarrollo con recarga en caliente
bun run build:css    # compila Tailwind (input.css -> index.css)
```

## Build

```bash
bun run build:stable   # build de producción (canal "stable")
bun run build:canary   # build de producción (canal "canary")
```

ElectroBun construye **para el sistema anfitrión** (OS + arquitectura de la máquina). No hay cross-compile: para generar el instalador de macOS Apple Silicon necesitas un Mac ARM, para Windows un Windows, etc.

### Artefactos por SO

Cada build de producción genera estos ficheros en `artifacts/`:

| Fichero | Qué es |
|---|---|
| `stable-<os>-<arch>-<App>.dmg` / `-Setup.zip` / `-Setup.tar.gz` | El **instalador** de la app |
| `stable-<os>-<arch>-<App>.tar.zst` | La app comprimida, lo que **descarga el auto-updater** |
| `stable-<os>-<arch>-update.json` | Manifiesto de versión consultado por el auto-updater |
| `stable-<os>-<arch>-<hash>.patch` | Diferencial para actualizaciones delta (desde la 2ª versión) |

> El instalador es uno por SO. Los otros ficheros (`tar.zst` + `update.json`) son el mecanismo de **auto-actualización**: la app consulta `release.baseUrl` y descarga el `tar.zst`. Si se eliminan, la auto-actualización deja de funcionar.

### Build de macOS para Intel (x64) de forma local

GitHub Actions ya no ofrece runners de macOS Intel, por lo que el pipeline no genera instalador `macos-x64`. Para producirlo manualmente en un **Mac con procesador Intel**:

```bash
bun install
bun run build:mac:intel   # = bun run build:stable
```

En un Mac Intel el build genera automáticamente los artefactos `stable-macos-x64-*` en `artifacts/`. Después, súbelos a una release de GitHub como assets (o a cualquier hosting compatible con `release.baseUrl`).

## Estructura del proyecto

```
electrobun.config.ts        # configuración de la app (nombre, vistas, release.baseUrl)
src/
├── bun/                    # proceso main (Bun runtime)
│   ├── index.ts            # ventana, menú, RPC, auto-actualización
│   ├── service.ts          # lógica de negocio y RPC handlers
│   └── login.ts            # login con webview nativa de SoundCloud
├── mainview/               # vista principal de la app (HTML + TS + Tailwind)
│   ├── index.html          # 6 vistas: Inicio, Descargas, Buscar, Colección, Ajustes, Desarrollador
│   ├── index.ts            # UI: cola, búsqueda, odómetro de ETA, progreso
│   └── input.css           # Tailwind v4
├── connecting/             # página "Conectando..." durante el login
├── shared/types.ts         # esquema RPC tipado compartido (AppRPCSchema)
├── cli.ts                  # CLI de descarga (bun run cli)
├── auth.ts                 # login por CLI (Playwright)
├── deps.ts                 # instalación de yt-dlp / ffmpeg
├── download.ts             # construcción de args y descarga con yt-dlp
├── store.ts                # config, cookies, caché de likes, histórico
└── util.ts                 # runStream + control de pausa (SIGSTOP/SIGCONT)
```

## Arquitectura

- **ElectroBun** empaqueta la app con un runtime Bun nativo y una webview (`Electroview`/`BrowserView`).
- El proceso **main** (`src/bun`) ejecuta yt-dlp, gestiona la sesión y la configuración.
- La **vista** (`src/mainview`) se comunica con el main mediante RPC tipado definido en `src/shared/types.ts` (handlers `requests` + mensajes `status`/`log`/`downloadProgress`).
- **Pausa/reanudar** se implementa enviando `SIGSTOP`/`SIGCONT` al proceso de yt-dlp (`child.kill`); **detener** envía `SIGKILL`.
- **Anti-bot**: cada descarga es secuencial (`downloadChain` en el service + cola en la UI). Sin paralelismo evita bloqueos de SoundCloud.

## Sesión de SoundCloud

- **Desde la app**: abre una ventana con la webview nativa cargando `soundcloud.com`, el usuario inicia sesión y la app captura la cookie `oauth_token`, que se guarda con permisos `0600` en el directorio de datos.
- **Desde CLI**: `bun run cli` abre un login con Playwright (stealth) y guarda el token.
- El `oauth_token` se pasa a yt-dlp como fichero de cookies Netscape para autenticar las descargas.

## Dependencias (yt-dlp / ffmpeg)

- Se descargan en `bin/` dentro del directorio de datos de la app o se usan las del sistema si existen.
- La app comprueba versiones, notifica actualizaciones y permite instalarlas desde la vista de Ajustes / Desarrollador.

## Pipeline de release (GitHub Actions)

| Workflow | Qué hace |
|---|---|
| `.github/workflows/release.yml` | Al pushear a `main`: calcula la siguiente versión semántica, crea el tag `v<version>` y dispara el build. |
| `.github/workflows/release-build.yml` | Matriz de build: `macos-arm64` (macos-14), `windows-x64` (windows-latest), `linux-x64` (ubuntu-latest). Sube todos los artefactos y publica la release con `softprops/action-gh-release`. |

Notas:

- Los commits conventional (`feat:`, `fix:`, `chore:`) determinan el bump (major/minor/patch).
- **No hay build de macOS Intel** porque GitHub ha retirado los runners Intel; solo Apple Silicon. Ver "Build de macOS para Intel" arriba.
- Los artefactos se publican en GitHub Releases; el `baseUrl` de auto-actualización apunta a `releases/latest/download`.

## CLI

El proyecto conserva una CLI independiente en `src/cli.ts`:

```bash
bun run cli                          # asistente interactivo (setup + descarga de favoritos)
bun run cli --setup                  # re-ejecutar el asistente
bun run cli --search "término"       # busca y descarga
bun run cli --yes --token <t> --username <u> --outdir <dir>   # no interactivo
```

## Scripts

| Comando | Descripción |
|---|---|
| `bun run dev` | App en desarrollo con recarga en caliente |
| `bun run build:stable` | Build de producción estable |
| `bun run build:canary` | Build de producción canary |
| `bun run build:mac:intel` | Build estable (para generar `macos-x64` en un Mac Intel) |
| `bun run build:css` | Compilar Tailwind |
| `bun run cli` | CLI de descarga |
