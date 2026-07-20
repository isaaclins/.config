import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = ["extension.ts", "src/index.ts", "README.md", "LICENSE"];

for (const file of required) {
  if (!existsSync(resolve(root, file))) {
    console.error(`Missing required file: ${file}`);
    process.exit(1);
  }
}
console.log("pack-check: all required files present");
