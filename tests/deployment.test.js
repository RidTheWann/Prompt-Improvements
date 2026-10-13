import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("GitHub Pages deployment copies every local module imported by the app", () => {
  const app = read("src/app.js");
  const workflow = read(".github/workflows/deploy.yml");
  const importPaths = [...app.matchAll(/from\\s+["'](\\.[^"']+)["']/g)].map((match) => match[1]);
  const moduleCopyLine = workflow.split(/\\r?\\n/).find((line) => line.trim().startsWith("cp src/app.js"));
  assert.ok(moduleCopyLine, "deployment workflow must copy the source modules into dist/src");

  for (const importPath of importPaths) {
    const sourcePath = resolve(root, "src", importPath.replace(/^\\.\\//, ""));
    assert.ok(existsSync(sourcePath), "imported source file must exist: " + importPath);
    assert.ok(moduleCopyLine.includes(importPath.replace(/^\\.\\//, "")), "deployment must copy imported module: " + importPath);
  }
});

test("service worker pre-cache points only to files that exist", () => {
  const serviceWorker = read("service-worker.js");
  const paths = [...serviceWorker.matchAll(/["']\\.\\/([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(paths.length > 0, "service worker app shell should not be empty");
  for (const path of paths) {
    assert.ok(existsSync(resolve(root, path)), "pre-cached asset must exist: " + path);
  }
});

test("all DOM ids referenced by app logic are present in the HTML shell", () => {
  const html = read("index.html");
  const app = read("src/app.js");
  const htmlIds = new Set([...html.matchAll(/\\bid=["']([^"']+)["']/g)].map((match) => match[1]));
  const appIds = new Set([...app.matchAll(/\\$\\(["']([^"']+)["']\\)/g)].map((match) => match[1]));
  const missing = [...appIds].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], "app references DOM ids missing from index.html");
});
