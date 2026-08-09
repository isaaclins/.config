import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
try {
  execFileSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], {
    cwd: root,
    stdio: "inherit",
  });
} catch (error) {
  process.exit(error.status || 1);
}
