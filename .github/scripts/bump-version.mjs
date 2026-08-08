#!/usr/bin/env node
// Calcula la siguiente versión a partir de los commits (conventional commits)
// desde la última etiqueta de versión y, con --apply, la escribe en
// package.json y electrobun.config.ts.
//
// Reglas:
//   BREAKING CHANGE / `feat!:` / `fix!:`  -> MAJOR
//   `feat:`                                -> MINOR
//   `fix:`                                 -> PATCH
//   cualquier otra cosa (docs, chore...)   -> sin release
//
// Si no hay etiqueta previa (primer release), se publica la versión actual.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

function git(args) {
  return execSync(`git ${args}`, { encoding: "utf8", cwd: ROOT }).trim();
}

function getLastTag() {
  try {
    const tags = git("tag --list 'v*' --sort=-v:refname")
      .split("\n")
      .filter(Boolean);
    return tags[0] ?? null;
  } catch {
    return null;
  }
}

function getCommitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  try {
    return git(`log --format=%s ${range}`).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// 0 = sin release, 1 = patch, 2 = minor, 3 = major
function bumpLevel(subjects) {
  let level = 0;
  for (const s of subjects) {
    if (/!:|BREAKING CHANGE:/i.test(s)) return 3;
    if (/^feat(\(.+\))?!?:/i.test(s)) level = Math.max(level, 2);
    else if (/^fix(\(.+\))?!?:/i.test(s)) level = Math.max(level, 1);
  }
  return level;
}

function inc(version, level) {
  const [maj = 0, min = 0, pat = 0] = version.split(".").map(Number);
  if (level >= 3) return `${maj + 1}.0.0`;
  if (level === 2) return `${maj}.${min + 1}.0`;
  if (level === 1) return `${maj}.${min}.${pat + 1}`;
  return version;
}

const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const current = pkg.version;

const lastTag = getLastTag();
const subjects = getCommitsSince(lastTag);
// Sin etiqueta previa => primer release, se publica la versión actual.
const next = lastTag ? inc(current, bumpLevel(subjects)) : current;

console.log(`current=${current}`);
console.log(`level=${bumpLevel(subjects)}`);
console.log(`next=${next}`);

if (process.argv.includes("--apply") && next !== current) {
  pkg.version = next;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  const cfgPath = path.join(ROOT, "electrobun.config.ts");
  const cfg = fs.readFileSync(cfgPath, "utf8");
  fs.writeFileSync(
    cfgPath,
    cfg.replace(/version:\s*"[^"]*"/, `version: "${next}"`),
  );
  console.log("applied");
} else if (process.argv.includes("--apply")) {
  console.log("no-bump");
}
