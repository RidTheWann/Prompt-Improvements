const MAX_QUERY_LENGTH = 240;

function plainText(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\\s+/g, " ")
    .trim();
}

export function detectSearchLanguage(query) {
  const text = String(query ?? "");
  return /\\b(aku|kamu|yang|dengan|untuk|adalah|bagaimana|mengapa|siapa|apa itu|jelaskan|terbaru|terkini|harga|berita|sekarang|hari ini|tolong|carikan|cari|riset|sumber)\\b/i.test(text)
    ? "id"
    : "en";
}

export function shouldSearchWeb(query) {
  const text = String(query ?? "").trim();
  if (text.length < 8) return false;
  const currentOrSearch = /\\b(terbaru|terkini|sekarang|saat ini|hari ini|minggu ini|bulan ini|tahun ini|harga|berita|cari|carikan|search|research|riset|sumber|referensi|dokumentasi|docs|versi|version|rilis|release|update|changelog|jadwal|siapa|kapan|berapa|dimana|di mana|apa itu|jelaskan|bandingkan|who is|what is|when|where|which|why|how|latest|current|today|news|price|official|documentation|compare|explain|history)\\b/i.test(text);
  if (currentOrSearch) return true;
  if (/\\b(halo|hai|hello|hi|terima kasih|makasih|thanks|thank you|tulis email|buat email|write an email|buat puisi|write a poem|buat cerita|write a story|brainstorm|caption instagram|perbaiki prompt|improve this prompt|terjemahkan|translate this)\\b/i.test(text)) return false;
  return false;
}

export async function searchWikipedia(query, { signal, fetchImpl = globalThis.fetch, maxResults = 5 } = {}) {
  const normalized = String(query ?? "").replace(/\\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
  if (!normalized) return [];
  const language = detectSearchLanguage(normalized);
  const endpoint = new URL("https://" + language + ".wikipedia.org/w/api.php");
  endpoint.searchParams.set("action", "query");
  endpoint.searchParams.set("list", "search");
  endpoint.searchParams.set("srsearch", normalized);
  endpoint.searchParams.set("utf8", "1");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("origin", "*");
  endpoint.searchParams.set("srlimit", String(Math.min(5, Math.max(1, maxResults))));
  const response = await fetchImpl(endpoint.href, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal
  });
  if (!response?.ok) {
    throw new Error("Pencarian Wikipedia gagal (HTTP " + String(response?.status ?? "unknown") + ").");
  }
  const payload = await response.json();
  const rows = payload?.query?.search;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const title = plainText(row?.title).slice(0, 240);
    const snippet = plainText(row?.snippet).slice(0, 1100);
    const slug = String(row?.title ?? "").replace(/\\s/g, "_");
    return {
      title,
      snippet,
      domain: language === "id" ? "Wikipedia Indonesia" : "Wikipedia",
      url: "https://" + language + ".wikipedia.org/wiki/" + encodeURIComponent(slug)
    };
  }).filter((item) => item.title && /^https:\\/\\//i.test(item.url)).slice(0, maxResults);
}
