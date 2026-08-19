import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJSON = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const peer = packageJSON.peerDependencies?.["@earendil-works/pi-coding-agent"];
if (peer !== "^0.80.3") {
  throw new Error(`Expected the supported Pi peer range ^0.80.3, got ${peer ?? "missing"}`);
}

try {
  const packagePath = resolve(root, "node_modules/@earendil-works/pi-coding-agent/package.json");
  if (!existsSync(packagePath)) {
    console.log("upgrade-check: Pi peer is not installed locally; package peer range is ^0.80.3");
    process.exit(0);
  }
  const installed = JSON.parse(readFileSync(packagePath, "utf8"));
  const [major, minor] = String(installed.version).split(".").map(Number);
  if (major !== 0 || minor < 80) {
    throw new Error(`Installed Pi ${installed.version} is outside the supported ^0.80.3 range`);
  }
  console.log(`upgrade-check: Pi ${installed.version} satisfies ${peer}`);
} catch (error) {
  if (error?.code === "MODULE_NOT_FOUND") {
    console.log("upgrade-check: Pi peer is not installed locally; package peer range is ^0.80.3");
  } else {
    throw error;
  }
}
