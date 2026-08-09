import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CHANNEL = "stable"; // Only stable builds are published to releases.

/**
 * Builds a single-file .exe installer for Windows with Inno Setup.
 *
 * Runs on the Windows CI runner right after `bun run build:stable`. It finds
 * the electrobun app bundle in build/, compiles the Inno Setup script in
 * scripts/windows/installer.iss, and replaces the electrobun Setup.zip with a
 * proper installer that adds Start Menu/desktop shortcuts, an uninstaller and
 * a registry entry (Add/Remove Programs).
 *
 * Requires Inno Setup 6 to be installed (choco install innosetup).
 */
async function main() {
  const config = (await import("../electrobun.config.ts")).default;
  const appName = config.app.name;
  const appId = config.app.identifier;
  const version = config.app.version;

  // getAppFileName() for the stable channel: name with spaces removed.
  const appFileName = appName.replace(/ /g, "");

  const platformPrefix = `${CHANNEL}-win-x64`;
  const bundleDir = join(ROOT, "build", platformPrefix, appFileName);
  const artifactsDir = join(ROOT, "artifacts");

  if (!existsSync(bundleDir)) {
    console.error(`App bundle not found at ${bundleDir}`);
    console.error("Run `bun run build:stable` on Windows first.");
    process.exit(1);
  }

  if (!existsSync(join(bundleDir, "bin", "launcher.exe"))) {
    console.error(`launcher.exe not found inside ${bundleDir}`);
    process.exit(1);
  }

  const iscc = findIscc();
  if (!iscc) {
    console.error(
      "Inno Setup 6 not found. Install it with: choco install innosetup -y",
    );
    process.exit(1);
  }

  const iss = join(ROOT, "scripts", "windows", "installer.iss");
  // Keep the same flat naming scheme as the rest of the release artifacts:
  // stable-win-x64-SoundCloudDownloader-Setup.exe (old: ...-Setup.zip).
  const outputBaseName = `${platformPrefix}-${appFileName}-Setup`;

  // Use forward slashes: Windows APIs accept them and ISPP does not treat them
  // as escape characters when passed through /D defines.
  const sourceDir = bundleDir.replace(/\\/g, "/");
  const outputDir = artifactsDir.replace(/\\/g, "/");

  const args = [
    iss,
    `/DMyAppName=${appName}`,
    `/DMyAppVersion=${version}`,
    `/DMyAppId=${appId}`,
    `/DMyChannel=${CHANNEL}`,
    `/DSourceDir=${sourceDir}`,
    `/DOutputDir=${outputDir}`,
    `/DOutputBaseName=${outputBaseName}`,
  ];

  console.log(`Compiling installer with ${iscc}...`);
  const result = spawnSync(iscc, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`ISCC failed with exit code ${result.status ?? "unknown"}`);
    process.exit(result.status ?? 1);
  }

  const installer = join(artifactsDir, `${outputBaseName}.exe`);
  if (!existsSync(installer)) {
    console.error(`Installer not produced: ${installer}`);
    process.exit(1);
  }

  // Remove the electrobun Setup.zip wrapper; the .exe installer replaces it.
  for (const file of readdirSync(artifactsDir)) {
    if (/^.*-Setup\.zip$/i.test(file)) {
      const zipPath = join(artifactsDir, file);
      console.log(`Removing legacy zip installer: ${zipPath}`);
      rmSync(zipPath);
    }
  }

  console.log(`Windows installer created: ${installer}`);
}

function findIscc(): string | null {
  if (process.env.ISCC) return process.env.ISCC;
  const candidates = [
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
