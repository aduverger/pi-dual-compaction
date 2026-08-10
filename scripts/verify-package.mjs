import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const expected = {
  name: "@aduverger/pi-dual-compaction",
  version: "0.1.1",
  repository: "git+https://github.com/aduverger/pi-dual-compaction.git",
  homepage: "https://github.com/aduverger/pi-dual-compaction#readme",
  bugs: "https://github.com/aduverger/pi-dual-compaction/issues",
  author: "Alexandre Duverger",
};
for (const [field, value] of Object.entries(expected)) {
  const actual = field === "repository" ? pkg.repository?.url : field === "bugs" ? pkg.bugs?.url : pkg[field];
  if (actual !== value) throw new Error(`package ${field} must be ${value}`);
}
if (pkg.publishConfig?.access !== "public") throw new Error("package must publish with public access");
if (!pkg.pi?.extensions?.includes("./src/extension.mjs")) throw new Error("Pi extension manifest missing");
if (JSON.stringify(pkg.exports) !== JSON.stringify({ ".": "./src/extension.mjs" })) {
  throw new Error("package must expose only the Pi extension entry point");
}
for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]) {
  if (pkg.dependencies?.[name]) throw new Error(`${name} must remain a peer dependency`);
  if (pkg.peerDependencies?.[name] !== "*") throw new Error(`${name} must use Pi's bundled runtime`);
}

const packEnvironment = { ...process.env, npm_config_cache: new URL("../.npm-cache", import.meta.url).pathname };
const packed = new Set(JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8", env: packEnvironment }))[0].files.map((file) => file.path));
const allowed = new Set([
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "package.json",
  "scripts/verify-package.mjs",
  "src/adapters.mjs",
  "src/config.mjs",
  "src/contract.mjs",
  "src/controller.mjs",
  "src/extension.mjs",
]);
for (const file of packed) if (!allowed.has(file)) throw new Error(`package contains unapproved file: ${file}`);
for (const file of allowed) if (!packed.has(file)) throw new Error(`package omits required file: ${file}`);
for (const file of packed) {
  if (/(^|\/)test(\/|$)|package-lock\.json|(^|\/)docs\//.test(file)) {
    throw new Error(`package contains forbidden development file: ${file}`);
  }
}
console.log("package verification passed");
