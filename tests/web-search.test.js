import test from "node:test";
import assert from "node:assert/strict";
import { detectSearchLanguage, searchWikipedia, shouldSearchWeb } from "../src/web-search.js";

test("web-search routing recognizes current-information queries and avoids creative defaults", () => {
  assert.equal(shouldSearchWeb("Berita terbaru perkembangan baterai sodium-ion"), true);
  assert.equal(shouldSearchWeb("Who is the current CEO of Example Corp?"), true);
  assert.equal(shouldSearchWeb("Jelaskan konsep API kepada pemula."), true);
  assert.equal(shouldSearchWeb("Buat puisi pendek tentang hujan"), false);
  assert.equal(shouldSearchWeb("Terima kasih banyak"), false);
});

test("Wikipedia search chooses the query language and sanitizes result snippets", async () => {
  let requestUrl;
  const results = await searchWikipedia("berita terbaru Indonesia", {
    fetchImpl: async (url, options) => {
      requestUrl = new URL(url);
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Accept, "application/json");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          query: {
            search: [
              { title: "Indonesia & teknologi", snippet: "<span class=\"searchmatch\">Berita</span> terbaru &amp; data" },
              { title: " ", snippet: "" }
            ]
          }
        })
      };
    }
  });
  assert.equal(requestUrl.hostname, "id.wikipedia.org");
  assert.equal(requestUrl.searchParams.get("origin"), "*");
  assert.equal(requestUrl.searchParams.get("srsearch"), "berita terbaru Indonesia");
  assert.equal(results.length, 1);
  assert.equal(results[0].snippet, "Berita terbaru & data");
  assert.match(results[0].url, /^https:\/\/id\.wikipedia\.org\/wiki\//);
  assert.doesNotMatch(results[0].snippet, /<|>/);
});

test("Wikipedia search bounds query length, result count and handles failure", async () => {
  let requestUrl;
  await searchWikipedia("x".repeat(400), {
    maxResults: 99,
    fetchImpl: async (url) => {
      requestUrl = new URL(url);
      return { ok: true, status: 200, json: async () => ({ query: { search: [] } }) };
    }
  });
  assert.equal(requestUrl.searchParams.get("srsearch").length, 240);
  assert.equal(requestUrl.searchParams.get("srlimit"), "5");
  await assert.rejects(
    searchWikipedia("test query", { fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /HTTP 503/
  );
});
