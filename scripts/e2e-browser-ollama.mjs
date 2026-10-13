import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const APP_URL = process.env.E2E_APP_URL || "http://127.0.0.1:4173/";
const OLLAMA_URL = process.env.E2E_OLLAMA_URL || "http://127.0.0.1:11434";
const MODEL = process.env.OLLAMA_TEST_MODEL || "qwen2.5:0.5b";
const browserErrors = [];
let browser;

async function waitForText(page, selector, expected, timeout = 300_000, startsWith = false) {
  await page.waitForFunction(
    ({ selector, expectedText, startsWith }) => {
      const element = document.querySelector(selector);
      const actual = element?.textContent || "";
      return startsWith ? actual.startsWith(expectedText) : actual.includes(expectedText);
    },
    { selector, expectedText: expected, startsWith },
    { timeout }
  );
}

async function readDownload(download) {
  const path = await download.path();
  assert.ok(path, "browser must create a downloadable file");
  return readFile(path, "utf8");
}

try {
  const tagsResponse = await fetch(OLLAMA_URL + "/api/tags");
  assert.equal(tagsResponse.status, 200, "Ollama /api/tags endpoint must be reachable");
  const tags = await tagsResponse.json();
  const models = (tags.models || []).map((item) => item.name || item.model);
  assert.ok(models.includes(MODEL), "the real Ollama model must be installed: " + MODEL);

  const chatResponse = await fetch(OLLAMA_URL + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: 'Reply with exactly the word "READY".' }],
      stream: false,
      options: { temperature: 0, num_predict: 16 }
    })
  });
  assert.equal(chatResponse.status, 200, "Ollama /api/chat must return HTTP 200");
  const chatPayload = await chatResponse.json();
  assert.ok(chatPayload.message?.content?.trim(), "real local model must generate a response");
  console.log("[PASS] Ollama API and actual model inference:", MODEL);

  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto(APP_URL, { waitUntil: "networkidle" });
  assert.match(await page.title(), /Prompt Improvements/i);
  await page.locator("#originalPrompt").fill("Make a summary.");
  await page.locator("#objective").fill("Produce a concise summary for a reader.");
  await page.locator("#context").fill("Use only the facts present in the supplied report.");
  await page.locator("#outputFormat").selectOption("markdown");

  await page.locator("#analyzeButton").click();
  const initialScore = await page.locator("#scoreValue").textContent();
  assert.match(initialScore || "", /^\d+$/, "analysis must calculate a structural score");
  assert.equal(await page.locator("#dimensionList .dimension-card").count(), 6);

  await page.locator("#improveButton").click();
  let structuredPrompt = await page.locator("#improvedPrompt").inputValue();
  assert.ok(structuredPrompt.includes("Make a summary."), "structured prompt must preserve the original instruction");
  assert.ok(structuredPrompt.includes("Use only the facts present in the supplied report."), "structured prompt must preserve added context");
  console.log("[PASS] Browser load, deterministic analysis, and structured prompt generation");

  await page.locator("#saveButton").click();
  await page.waitForFunction(() => (document.querySelector("#historyCount")?.textContent || "").includes("1 versi"));
  await page.reload({ waitUntil: "networkidle" });
  assert.match((await page.locator("#historyCount").textContent()) || "", /1 versi/);
  assert.equal(await page.locator(".history-card").count(), 1, "saved version must survive a browser reload");

  await page.locator("#originalPrompt").fill("Make a summary.");
  await page.locator("#objective").fill("Produce a concise summary for a reader.");
  await page.locator("#context").fill("Use only the facts present in the supplied report.");
  await page.locator("#outputFormat").selectOption("markdown");
  await page.locator("#improveButton").click();

  const [markdownDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#downloadButton").click()
  ]);
  const markdown = await readDownload(markdownDownload);
  assert.ok(markdown.includes("# Prompt yang Disempurnakan"), "Markdown export must contain the generated prompt");

  const [promptJsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#exportJsonButton").click()
  ]);
  const promptReport = JSON.parse(await readDownload(promptJsonDownload));
  assert.equal(promptReport.schemaVersion, 1);
  assert.equal(promptReport.originalPrompt, "Make a summary.");
  console.log("[PASS] Local version persistence and valid Markdown/JSON downloads");

  await page.locator("#engineMode").selectOption("ollama");
  await page.locator("#checkOllamaButton").click();
  await waitForText(page, "#ollamaStatus", "Terhubung", 30_000);
  assert.equal(await page.locator("#ollamaModel").inputValue(), MODEL);

  await page.locator("#improveButton").click();
  await waitForText(page, "#resultStatus", "AI lokal selesai", 300_000);
  const aiPrompt = (await page.locator("#improvedPrompt").inputValue()).trim();
  assert.ok(aiPrompt.length > 20, "the app must return a non-empty AI-refined prompt");
  assert.match(aiPrompt, /summary|report|facts|concise/i, "AI result should preserve the requested topic");
  console.log("[PASS] Real browser -> Ollama model discovery -> /api/chat prompt refinement");

  await page.locator("#engineMode").selectOption("rules");
  const strictPrompt = 'Return only valid JSON with exactly two keys: "summary" and "risks". The summary must be a short string and risks must be an array. Use only the supplied report as source material. Output no Markdown or text outside the JSON.';
  await page.locator("#originalPrompt").fill(strictPrompt);
  await page.locator("#objective").fill("Return machine-readable JSON from a synthetic report.");
  await page.locator("#context").fill("This is a deterministic regression test; preserve the exact output contract.");
  await page.locator("#outputFormat").selectOption("json");
  await page.locator("#successCriteria").fill("Output parses as JSON and contains summary and risks.");
  await page.locator("#improveButton").click();

  await page.locator("#evalCaseName").fill("Strict JSON contract");
  await page.locator("#evalInput").fill("Synthetic report: release completed successfully; zero warnings; no unresolved issues.");
  await page.locator('label[for="evalRequireJson"]').click();
  assert.equal(await page.locator("#evalRequireJson").isChecked(), true, "JSON toggle label must activate the checkbox");
  await page.locator("#evalRequiredKeys").fill("summary, risks");
  await page.locator("#evalMaxWords").fill("100");
  await page.locator("#addEvalCaseButton").click();
  assert.equal(await page.locator(".eval-case-card").count(), 1);
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator(".eval-case-card").count(), 1, "test case must persist locally after reload");

  await page.locator("#originalPrompt").fill(strictPrompt);
  await page.locator("#objective").fill("Return machine-readable JSON from a synthetic report.");
  await page.locator("#context").fill("This is a deterministic regression test; preserve the exact output contract.");
  await page.locator("#outputFormat").selectOption("json");
  await page.locator("#successCriteria").fill("Output parses as JSON and contains summary and risks.");
  await page.locator("#improveButton").click();

  await page.locator("#engineMode").selectOption("ollama");
  await page.locator("#checkOllamaButton").click();
  await waitForText(page, "#ollamaStatus", "Terhubung", 30_000);
  await page.locator("#engineMode").selectOption("rules");
  await page.locator("#improveButton").click();

  await page.locator("#runEvaluationButton").click();
  await waitForText(page, "#evalRunStatus", "Selesai", 600_000, true);
  const [evaluationDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#downloadEvaluationButton").click()
  ]);
  const evaluationReport = JSON.parse(await readDownload(evaluationDownload));
  assert.equal(evaluationReport.schemaVersion, 1);
  assert.equal(evaluationReport.model, MODEL);
  assert.equal(evaluationReport.summary.totalCases, 1);
  assert.equal(evaluationReport.results.length, 1);
  assert.ok(evaluationReport.results[0].baseline?.output, "baseline must have real model output");
  assert.ok(evaluationReport.results[0].candidate?.output, "revised prompt must have real model output");
  assert.ok(Number.isInteger(evaluationReport.results[0].baseline.score));
  assert.ok(Number.isInteger(evaluationReport.results[0].candidate.score));
  console.log("[PASS] A/B regression suite executed against the same real local model; valid JSON report exported");

  await page.locator("#iterationFeedback").fill("Be explicit that the output must not contain Markdown.");
  await page.locator("#iterateButton").click();
  await waitForText(page, "#resultStatus", "Iterasi", 30_000);
  const iterated = await page.locator("#improvedPrompt").inputValue();
  assert.ok(iterated.includes("Be explicit that the output must not contain Markdown."));
  console.log("[PASS] Iteration feedback is applied and preserved in the next prompt");

  await page.locator("#autoOptimizationIterations").selectOption("1");
  await page.locator("#autoOptimizeButton").click();
  await page.waitForFunction(() => {
    const start = document.querySelector("#autoOptimizeButton");
    const stop = document.querySelector("#stopOptimizationButton");
    return start && !start.disabled && stop?.hidden === true;
  }, null, { timeout: 300_000 });
  const optimizationStatus = (await page.locator("#evalRunStatus").textContent()) || "";
  assert.ok(optimizationStatus.startsWith("Optimasi selesai"), "automatic optimizer finished with an error: " + optimizationStatus);
  const [optimizedReportDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#downloadEvaluationButton").click()
  ]);
  const optimizedReport = JSON.parse(await readDownload(optimizedReportDownload));
  assert.equal(optimizedReport.optimization?.strategy, "guarded-local-search");
  assert.equal(optimizedReport.optimization?.maxIterations, 1);
  assert.ok(Array.isArray(optimizedReport.optimization?.trials));
  assert.ok(optimizedReport.optimization.trials.length >= 1);
  assert.ok(optimizedReport.candidatePrompt, "the best prompt must remain available after optimization");
  console.log("[PASS] Guarded automatic optimization evaluates candidates and exports its full trial history");

  assert.deepEqual(browserErrors, [], "browser must not raise uncaught JavaScript errors");
  await context.close();
  console.log("[PASS] No uncaught browser JavaScript errors");
  console.log("E2E SUMMARY: passed all browser and local-model assertions.");
} catch (error) {
  console.error("E2E FAILURE:", error?.stack || error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}
