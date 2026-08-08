import { spawnSync } from "node:child_process";

// Compila Tailwind CSS antes de cada build de electrobun.
// Se usa `bun x` (no `bunx`) para que funcione también en Windows.
const r = spawnSync(
  "bun",
  [
    "x",
    "@tailwindcss/cli",
    "-i",
    "src/mainview/input.css",
    "-o",
    "src/mainview/index.css",
  ],
  { stdio: "inherit" },
);
process.exit(r.status ?? 1);
