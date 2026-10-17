import assert from "node:assert/strict";
import { chromium } from "playwright";

const appUrl = process.env.E2E_APP_URL || "http://127.0.0.1:4173/";
const browserErrors = [];
let browser;

try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"]
  });
  const page = await context.newPage();
  const externalRequests = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== new URL(appUrl).origin) externalRequests.push(request.url());
  });

  const response = await page.goto(appUrl, { waitUntil: "networkidle" });
  assert.equal(response?.status(), 200, "the static application must load");
  assert.match(await page.title(), /Prompt Improvements/i);
  assert.equal(await page.locator("#engineSettings").evaluate((element) => element.open), false);
  assert.equal(await page.locator("#contextDetails").evaluate((element) => element.open), false);
  assert.equal(await page.locator("#evaluationSection").isVisible(), false);
  assert.equal(await page.locator("#copyButton").isDisabled(), true);
  assert.equal(await page.locator("#analyzeButton").isVisible(), false, "analysis is hidden from the beginner flow");

  const original = "Buat email singkat untuk mengucapkan terima kasih.";
  await page.locator("#originalPrompt").fill(original);
  await page.locator("#improveButton").click();
  await page.waitForFunction(() => document.querySelector("#improvedPrompt").value.includes("## Permintaan asli"));
  const output = await page.locator("#improvedPrompt").inputValue();
  assert.ok(output.includes(original), "generated prompt must preserve the source request");
  assert.equal(await page.locator("#copyButton").isDisabled(), false);
  assert.equal(await page.locator("#saveButton").isDisabled(), false);
  assert.equal(await page.locator("#outputPanel").evaluate((element) => element.classList.contains("has-result")), true);
  console.log("[PASS] Default-mode prompt generation, result state, and source fidelity");

  await page.locator("#copyButton").click();
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Prompt disalin"));
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clipboard, output.trim(), "copy action must write the trimmed prompt text");
  await page.locator("#saveButton").click();
  assert.equal(await page.locator(".history-card").count(), 1);
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator(".history-card").count(), 1, "saved version must survive a reload");
  console.log("[PASS] Clipboard copy and local history persistence");

  await page.locator("#engineSettings").evaluate((element) => { element.open = true; });
  await page.locator("#engineMode").selectOption("ai");
  await page.locator("#llmApiKey").fill("e2e-secret-must-not-persist");
  await page.locator("#llmApiKey").dispatchEvent("change");
  const stored = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage)
  }));
  assert.equal(JSON.stringify(stored).includes("e2e-secret-must-not-persist"), false);
  assert.equal(JSON.stringify(stored).includes("prompt-improvements.api-key.persist"), false);
  assert.equal(JSON.stringify(stored).includes("prompt-improvements.api-key.session"), false);
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator("#llmApiKey").inputValue(), "", "API key is intentionally cleared on reload");
  console.log("[PASS] API key remains memory-only and is cleared on reload");

  await page.locator('button[data-template="learn"]').click();
  assert.match(await page.locator("#originalPrompt").inputValue(), /\[topik\]/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#originalPrompt").fill("Jelaskan fotosintesis dengan sederhana.");
  await page.locator("#improveButton").click();
  await page.waitForFunction(() => document.querySelector("#improvedPrompt").value.includes("## Permintaan asli"));
  assert.equal(await page.locator("#outputPanel").isVisible(), true);
  assert.equal(await page.locator("#copyButton").isDisabled(), false);
  console.log("[PASS] Starter template selection and mobile generation flow");

  assert.deepEqual(browserErrors, [], "browser must not raise uncaught JavaScript errors");
  assert.deepEqual(externalRequests, [], "free/default workflow must not make external network requests");
  console.log("[PASS] No uncaught JavaScript errors or external requests in free mode");
  await context.close();
  console.log("E2E SUMMARY: all browser smoke assertions passed.");
} catch (error) {
  console.error("BROWSER E2E FAILURE:", error?.stack || error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}
