import { readFileSync, writeFileSync } from "node:fs";

const USAGE = "usage: npm run bump -- <patch|minor|major|x.y.z>";
const SEMVER = /^\d+\.\d+\.\d+$/;
const JSON_INDENT = 2;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function nextVersion(current, arg) {
  if (SEMVER.test(arg)) return arg;
  const [major, minor, patch] = current.split(".").map(Number);
  if (arg === "major") return `${major + 1}.0.0`;
  if (arg === "minor") return `${major}.${minor + 1}.0`;
  if (arg === "patch") return `${major}.${minor}.${patch + 1}`;
  fail(USAGE);
}

function updateJson(path, mutate) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  mutate(data);
  writeFileSync(path, `${JSON.stringify(data, null, JSON_INDENT)}\n`);
}

function updateText(path, search, replacement) {
  const text = readFileSync(path, "utf8");
  if (!text.includes(search)) fail(`${path}: "${search}" not found`);
  writeFileSync(path, text.replace(search, replacement));
}

const arg = process.argv[2];
if (!arg) fail(USAGE);

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const current = pkg.version;
if (!SEMVER.test(current)) fail(`package.json: invalid current version "${current}"`);

const sources = {
  "package-lock.json": JSON.parse(readFileSync("package-lock.json", "utf8")).version,
  "src-tauri/tauri.conf.json": JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version,
};
for (const [path, version] of Object.entries(sources)) {
  if (version !== current) {
    fail(`${path} is at ${version} but package.json is at ${current} — fix manually first`);
  }
}

const target = nextVersion(current, arg);

updateText("package.json", `"version": "${current}"`, `"version": "${target}"`);
updateJson("package-lock.json", (data) => {
  data.version = target;
  data.packages[""].version = target;
});
updateText("src-tauri/tauri.conf.json", `"version": "${current}"`, `"version": "${target}"`);
updateText("src-tauri/Cargo.toml", `version = "${current}"`, `version = "${target}"`);
updateText(
  "src-tauri/Cargo.lock",
  `name = "gatehouse"\nversion = "${current}"`,
  `name = "gatehouse"\nversion = "${target}"`,
);

console.log(`${current} -> ${target}`);
console.log("updated: package.json, package-lock.json, src-tauri/{tauri.conf.json, Cargo.toml, Cargo.lock}");
console.log(`release: git commit -am "chore: v${target}" && git tag v${target} && git push origin main v${target}`);
