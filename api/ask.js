import * as cheerio from "cheerio";
import pdf from "pdf-parse";

/* =========================
   إعدادات عامة
========================= */
const MAX_RESULTS_PER_SEARCH = 8;
const MAX_UNIQUE_RESULTS = 24;
const MAX_SOURCES_FOR_EXTRACTION = 10;
const MAX_CHARS_PER_SOURCE = 6000;
const FETCH_TIMEOUT_MS = 15000;

/* =========================
   فلترة المصادر القانونية السعودية
========================= */
const ALLOWED_DOMAINS = [
  "laws.boe.gov.sa",
  "boe.gov.sa",
  "moj.gov.sa",
  "hrsd.gov.sa",
  "mc.gov.sa",
  "gosi.gov.sa",
  "edu.sa",
  "linkedin.com",
  "x.com",
  "twitter.com"
];

const DOMAIN_FILTER = `(
site:laws.boe.gov.sa OR
site:boe.gov.sa OR
site:moj.gov.sa OR
site:hrsd.gov.sa OR
site:mc.gov.sa OR
site:gosi.gov.sa OR
site:edu.sa OR
site:linkedin.com OR
site:x.com OR
site:twitter.com
)`;

/* =========================
   أوزان الدومينات
========================= */
const DOMAIN_WEIGHTS = {
  "laws.boe.gov.sa": 100,
  "boe.gov.sa": 95,
  "moj.gov.sa": 90,
  "hrsd.gov.sa": 88,
  "mc.gov.sa": 84,
  "gosi.gov.sa": 82,
  "edu.sa": 72,
  "linkedin.com": 38,
  "x.com": 22,
  "twitter.com": 22
};

/* =========================
   أدوات مساعدة
========================= */
function normalizeArabic(text = "") {
  return text
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .trim();
}

function cleanWhitespace(text = "") {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function escapeHtml(text = "") {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getHostname(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isAllowedDomain(url = "") {
  const host = getHostname(url);
  return ALLOWED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

function getDomainWeight(url = "") {
  const host = getHostname(url);

  if (!host) return 0;

  for (const domain of Object.keys(DOMAIN_WEIGHTS)) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      return DOMAIN_WEIGHTS[domain];
    }
  }

  return 0;
}

function countKeywordMatches(text = "", keywords = []) {
  const haystack = normalizeArabic(text);
  let score = 0;

  for (const keyword of keywords) {
    const k = normalizeArabic(keyword);
    if (!k) continue;
    if (haystack.includes(k)) score += 1;
  }

  return score;
}

function extractKeywords(query = "") {
  const stopWords = new Set([
    "ما", "ماذا", "هل", "كم", "كيف", "متى", "من", "على", "في", "الى", "إلى",
    "عن", "او", "أو", "ثم", "أن", "إن", "اذا", "إذا", "مع", "بين", "هذا", "هذه",
    "ذلك", "تلك", "هناك", "هنا", "كان", "كانت", "يكون", "تكون", "الذي", "التي",
    "الذين", "اللاتي", "ماهو", "ماهي", "حول", "بشأن", "بخصوص"
  ]);

  return normalizeArabic(query)
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !stopWords.has(w));
}

function dedupeResults(results = []) {
  const seen = new Set();
  const out = [];

  for (const item of results) {
    if (!item?.url) continue;

    let normalizedUrl = item.url.trim();

    try {
      const u = new URL(normalizedUrl);
      u.hash = "";
      normalizedUrl = u.toString();
    } catch {
      continue;
    }

    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);

    out.push({
      ...item,
      url: normalizedUrl
    });
  }

  return out;
}

function dedupeSourcesForDisplay(sources = []) {
  const seen = new Set();
  const out = [];

  for (const s of sources) {
    const key = `${s.url}::${s.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }

  return out;
}

function buildSearchQueries(query = "") {
  const base = query.trim();

  return [
    `${base} نص النظام السعودي مادة`,
    `${base} شرح قانوني سعودي`,
    `${base} دراسة قانونية سعودية`,
    `${base} لائحة تنفيذية`,
    `${base} PDF`
  ];
}

function buildAbortSignal(timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

/* =========================
   البحث عبر Serper
========================= */
async function serperSearch(query) {
  const finalQuery = `${query} ${DOMAIN_FILTER}`;

  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      q: finalQuery,
      num: MAX_RESULTS_PER_SEARCH
    })
  });

  const raw = await resp.text();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`فشل قراءة استجابة Serper: ${raw}`);
  }

  if (!resp.ok) {
    throw new Error(data?.message || "خطأ في Serper");
  }

  if (!Array.isArray(data.organic)) return [];

  return data.organic
    .map((r) => ({
      title: r.title || "مصدر",
      url: r.link || "",
      snippet: r.snippet || "",
      searchQuery: query
    }))
    .filter((r) => r.url && isAllowedDomain(r.url));
}

/* =========================
   ترتيب النتائج
========================= */
function scoreSearchResult(result, userQuery) {
  const title = result?.title || "";
  const snippet = result?.snippet || "";
  const url = result?.url || "";
  const keywords = extractKeywords(userQuery);

  let score = 0;

  const domainWeight = getDomainWeight(url);
  score += domainWeight;

  const titleMatches = countKeywordMatches(title, keywords);
  const snippetMatches = countKeywordMatches(snippet, keywords);

  score += titleMatches * 8;
  score += snippetMatches * 4;

  const fullText = `${title} ${snippet}`.toLowerCase();

  if (fullText.includes("نظام")) score += 8;
  if (fullText.includes("لائحة")) score += 7;
  if (fullText.includes("مادة")) score += 10;
  if (fullText.includes("pdf")) score += 4;
  if (url.toLowerCase().endsWith(".pdf")) score += 6;

  if (url.includes("linkedin.com")) score -= 8;
  if (url.includes("x.com") || url.includes("twitter.com")) score -= 12;

  return score;
}

function rankResults(results, userQuery) {
  return results
    .map((r) => ({
      ...r,
      score: scoreSearchResult(r, userQuery)
    }))
    .sort((a, b) => b.score - a.score);
}

/* =========================
   تنظيف HTML واستخراج النص
========================= */
function cleanExtractedText(text = "") {
  let out = text;

  out = out.replace(/\r/g, "\n");
  out = out.replace(/\t/g, " ");
  out = out.replace(/[ ]{2,}/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");

  const lines = out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.length > 20);

  out = lines.join("\n");
  out = cleanWhitespace(out);

  return out.slice(0, MAX_CHARS_PER_SOURCE);
}

function pickMainHtmlText($) {
  const preferredSelectors = [
    "main",
    "article",
    ".article",
    ".article-content",
    ".article-body",
    ".content",
    ".post",
    ".post-content",
    ".entry-content",
    ".main-content",
    "#content"
  ];

  for (const selector of preferredSelectors) {
    const el = $(selector).first();
    const text = el.text()?.trim();
    if (text && text.length > 300) {
      return text;
    }
  }

  return $("body").text() || "";
}

async function extractText(url) {
  const { signal, clear } = buildAbortSignal();

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      },
      signal
    });

    if (!resp.ok) return "";

    const buf = await resp.arrayBuffer();
    const contentType = (resp.headers.get("content-type") || "").toLowerCase();

    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      const parsed = await pdf(Buffer.from(buf));
      return cleanExtractedText(parsed.text || "");
    }

    const html = Buffer.from(buf).toString("utf8");
    const $ = cheerio.load(html);

    $("script, style, nav, footer, header, aside, noscript, iframe, form").remove();

    const rawText = pickMainHtmlText($);
    return cleanExtractedText(rawText);
  } catch {
    return "";
  } finally {
    clear();
  }
}

/* =========================
   اختيار أفضل المصادر بعد الاستخراج
========================= */
function scoreExtractedSource(source, query) {
  const keywords = extractKeywords(query);
  const combined = `${source.title} ${source.snippet} ${source.text}`;
  let score = source.score || 0;

  score += countKeywordMatches(combined, keywords) * 3;

  if (source.text.length >= 500) score += 8;
  if (source.text.length >= 1200) score += 5;
  if (source.text.length < 150) score -= 25;

  if (source.url.includes("laws.boe.gov.sa")) score += 10;
  if (source.url.includes("boe.gov.sa")) score += 8;
  if (source.url.includes("moj.gov.sa")) score += 6;

  return score;
}

/* =========================
   استخراج نص رد OpenAI
========================= */
function extractOpenAIText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];

  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if ((part.type === "output_text" || part.type === "text") && part.text) {
            parts.push(part.text);
          }
        }
      }
    }
  }

  return parts.join("\n").trim();
}

/* =========================
   بناء برومبت التحليل
========================= */
function buildAnalysisPrompt(query, sources) {
  const formattedSources = sources
    .map((s, index) => {
      return `
[المصدر ${index + 1}]
العنوان: ${s.title}
الرابط: ${s.url}
نوع المصدر: ${s.sourceType}
الدرجة: ${s.finalScore}
الملخص: ${s.snippet}
النص المستخرج:
${s.text || "لم يمكن استخراج نص كافٍ."}
`;
    })
    .join("\n-----------------------------\n");

  return `
السؤال القانوني:
${query}

المصادر المتاحة:
${formattedSources}

أنت باحث قانوني سعودي متخصص، ومطلوب منك تقديم إجابة دقيقة ومحافظة ومبنية على الأدلة المرفقة فقط.

قواعد إلزامية:
- اعتمد أولًا على النصوص النظامية واللوائح والمصادر الرسمية.
- بعد ذلك يمكن الاستفادة من الشروح والمقالات والأبحاث كمصادر تفسيرية مساندة.
- لا تذكر أي مادة أو حكم أو استنتاج لم يظهر له أساس واضح في المصادر المرفقة.
- إذا كانت المصادر غير كافية أو كان الجواب غير جازم، فقل ذلك بوضوح.
- فرّق بين "النص النظامي" و"التحليل" و"الرأي التفسيري".
- اكتب بالعربية الفصيحة الواضحة.
- اجعل الجواب بصيغة HTML فقط دون أي شرح خارج HTML.
- لا تضع <html> أو <body>.

هيكل الإجابة المطلوب:

<h2>عنوان الموضوع</h2>

<h3>توصيف السؤال</h3>
<p>...</p>

<h3>الأساس النظامي</h3>
<p>...</p>

<h3>التحليل القانوني</h3>
<ul>
  <li>...</li>
  <li>...</li>
</ul>

<h3>مستوى اليقين</h3>
<p>اذكر هل النتيجة قطعية أو ترجيحية أو تحتاج لمصدر إضافي.</p>

<h3>الخلاصة</h3>
<p>...</p>

<h3>المراجع</h3>
<ul>
  <li><a href="..." target="_blank" rel="noopener noreferrer">اسم المصدر</a> - وصف مختصر</li>
</ul>

تعليمات إضافية مهمة:
- حاول الإشارة إلى المصدر داخل الفقرة بصياغة مثل: (استنادًا إلى المصدر 1) أو (بحسب المصدر 2).
- لا تكرر نفس الفكرة بلا حاجة.
- إن لم توجد نصوص رسمية كافية، فاذكر ذلك صراحة.
`;
}

/* =========================
   استدعاء OpenAI
========================= */
async function generateAnswerWithOpenAI(prompt) {
  const openaiResp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      input: prompt,
      max_output_tokens: 3000
    })
  });

  const raw = await openaiResp.text();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(raw || "تعذر قراءة استجابة OpenAI");
  }

  if (!openaiResp.ok) {
    throw new Error(data?.error?.message || "خطأ في OpenAI");
  }

  return extractOpenAIText(data);
}

/* =========================
   fallback HTML
========================= */
function buildFallbackHtml(query, sources) {
  const items = sources
    .map((s) => {
      return `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a></li>`;
    })
    .join("");

  return `
<h2>نتيجة أولية حول السؤال</h2>
<h3>توصيف السؤال</h3>
<p>${escapeHtml(query)}</p>
<h3>ملاحظة</h3>
<p>تم العثور على مصادر قانونية مرتبطة بالسؤال، لكن تعذر إنتاج تحليل نهائي كامل في هذه المحاولة.</p>
<h3>المراجع</h3>
<ul>${items}</ul>
`;
}

/* =========================
   تحديد نوع المصدر
========================= */
function detectSourceType(url = "") {
  const host = getHostname(url);

  if (host.includes("laws.boe.gov.sa") || host === "boe.gov.sa" || host.endsWith(".boe.gov.sa")) {
    return "رسمي";
  }

  if (host.includes("moj.gov.sa") || host.includes("hrsd.gov.sa") || host.includes("mc.gov.sa") || host.includes("gosi.gov.sa")) {
    return "رسمي";
  }

  if (host.endsWith("edu.sa")) {
    return "بحثي / أكاديمي";
  }

  if (host.includes("linkedin.com")) {
    return "مهني / تحليلي";
  }

  if (host.includes("x.com") || host.includes("twitter.com")) {
    return "منشور عام";
  }

  return "مصدر قانوني";
}

/* =========================
   الخادم
========================= */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { query } = req.body || {};

  if (!query || !query.trim()) {
    return res.status(400).json({ error: "يرجى إدخال السؤال" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY غير موجود" });
  }

  if (!process.env.SERPER_API_KEY) {
    return res.status(500).json({ error: "SERPER_API_KEY غير موجود" });
  }

  try {
    const searchQueries = buildSearchQueries(query);

    const searchResultsArrays = await Promise.all(
      searchQueries.map((q) => serperSearch(q))
    );

    let allResults = searchResultsArrays.flat();
    allResults = dedupeResults(allResults);
    allResults = rankResults(allResults, query).slice(0, MAX_UNIQUE_RESULTS);

    if (!allResults.length) {
      return res.status(200).json({
        content: "<p>تعذر العثور على نتائج كافية في المصادر القانونية المحددة.</p>",
        sources: [],
        type: "إجابة قانونية",
        meta: {
          query,
          searchQueries,
          resultsCount: 0,
          extractedCount: 0,
          selectedSourcesCount: 0
        }
      });
    }

    const topResultsForExtraction = allResults.slice(0, MAX_SOURCES_FOR_EXTRACTION);

    const extractedSourcesRaw = await Promise.all(
      topResultsForExtraction.map(async (r) => {
        const text = await extractText(r.url);

        return {
          ...r,
          text,
          sourceType: detectSourceType(r.url)
        };
      })
    );

    const extractedSources = extractedSourcesRaw
      .filter((s) => s.text && s.text.length >= 120)
      .map((s) => ({
        ...s,
        finalScore: scoreExtractedSource(s, query)
      }))
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, 6);

    if (!extractedSources.length) {
      const fallbackSources = topResultsForExtraction.slice(0, 5).map((s) => ({
        title: s.title,
        url: s.url
      }));

      return res.status(200).json({
        content: buildFallbackHtml(query, fallbackSources),
        sources: fallbackSources,
        type: "إجابة قانونية",
        meta: {
          query,
          searchQueries,
          resultsCount: allResults.length,
          extractedCount: 0,
          selectedSourcesCount: 0
        }
      });
    }

    const prompt = buildAnalysisPrompt(query, extractedSources);
    let content = "";

    try {
      content = await generateAnswerWithOpenAI(prompt);
    } catch {
      content = buildFallbackHtml(query, extractedSources);
    }

    if (!content || !content.trim()) {
      content = buildFallbackHtml(query, extractedSources);
    }

    const displaySources = dedupeSourcesForDisplay(
      extractedSources.map((s) => ({
        title: s.title,
        url: s.url,
        snippet: s.snippet,
        sourceType: s.sourceType,
        score: s.finalScore
      }))
    );

    return res.status(200).json({
      content,
      sources: displaySources,
      type: "إجابة قانونية",
      meta: {
        query,
        searchQueries,
        resultsCount: allResults.length,
        extractedCount: extractedSourcesRaw.filter((s) => s.text && s.text.length >= 120).length,
        selectedSourcesCount: extractedSources.length,
        model: "gpt-4.1"
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "خطأ غير متوقع"
    });
  }
}
