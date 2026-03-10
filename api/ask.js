import * as cheerio from "cheerio";
import pdf from "pdf-parse";
import { applyLegalRules } from "../lib/legalRules.js";

/* ====== إعدادات ====== */
const MAX_RESULTS_PER_SEARCH = 8;
const MAX_SOURCES = 24;
const MAX_CHARS_PER_SOURCE = 7000;
const FETCH_TIMEOUT_MS = 15000;

/* ====== فلترة المصادر القانونية السعودية ====== */
const DOMAIN_FILTER = `
(site:boe.gov.sa OR
site:laws.boe.gov.sa OR
site:moj.gov.sa OR
site:hrsd.gov.sa OR
site:mc.gov.sa OR
site:gosi.gov.sa OR
site:edu.sa OR
site:linkedin.com OR
site:x.com OR
site:twitter.com OR
site:tiktok.com)
`;

/* ====== تصنيف المصادر ====== */
function getHostname(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function getSourceCategory(url = "") {
  const host = getHostname(url);

  if (
    host === "laws.boe.gov.sa" ||
    host.endsWith(".boe.gov.sa") ||
    host === "boe.gov.sa" ||
    host === "moj.gov.sa" ||
    host.endsWith(".moj.gov.sa") ||
    host === "hrsd.gov.sa" ||
    host.endsWith(".hrsd.gov.sa") ||
    host === "mc.gov.sa" ||
    host.endsWith(".mc.gov.sa") ||
    host === "gosi.gov.sa" ||
    host.endsWith(".gosi.gov.sa")
  ) {
    return "official";
  }

  if (host === "edu.sa" || host.endsWith(".edu.sa")) {
    return "academic";
  }

  if (host.includes("linkedin.com")) {
    return "professional_article";
  }

  if (host.includes("x.com") || host.includes("twitter.com")) {
    return "twitter";
  }

  if (host.includes("tiktok.com")) {
    return "tiktok";
  }

  return "other";
}

function classifySourceLabel(url = "") {
  switch (getSourceCategory(url)) {
    case "official":
      return "رسمي";
    case "academic":
      return "أكاديمي";
    case "professional_article":
      return "مهني / مقالي";
    case "twitter":
      return "إكس / تويتر";
    case "tiktok":
      return "تيك توك";
    default:
      return "مصدر قانوني";
  }
}

function getBaseSourceWeight(url = "") {
  const category = getSourceCategory(url);

  switch (category) {
    case "official":
      return 100;
    case "academic":
      return 88;
    case "professional_article":
      return 80;
    case "twitter":
      return 76;
    case "tiktok":
      return 68;
    default:
      return 55;
  }
}

/* ====== أدوات مساعدة ====== */
function cleanText(text = "") {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function dedupeSources(arr = []) {
  const seen = new Set();
  const out = [];

  for (const r of arr) {
    if (!r.url) continue;

    let normalized = r.url.trim();

    try {
      const u = new URL(normalized);
      u.hash = "";
      normalized = u.toString();
    } catch {
      continue;
    }

    if (seen.has(normalized)) continue;
    seen.add(normalized);

    out.push({
      ...r,
      url: normalized
    });
  }

  return out;
}

function buildAbortController(timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return {
    controller,
    clear: () => clearTimeout(timeout)
  };
}

function normalizeArabic(text = "") {
  return text
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .toLowerCase()
    .trim();
}

function extractKeywords(query = "") {
  const stopWords = new Set([
    "ما", "ماذا", "هل", "كم", "كيف", "متى", "من", "الى", "إلى", "على", "في", "عن",
    "او", "أو", "ثم", "أن", "إن", "اذا", "إذا", "مع", "بين", "هذا", "هذه", "ذلك",
    "تلك", "هناك", "هنا", "الذي", "التي", "الذين", "اللاتي", "ماهو", "ماهي", "حول",
    "بشأن", "بخصوص", "بعد", "قبل", "عند", "ضمن", "فيه", "فيها", "كان", "كانت"
  ]);

  return normalizeArabic(query)
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !stopWords.has(w));
}

function countKeywordMatches(text = "", keywords = []) {
  const haystack = normalizeArabic(text);
  let count = 0;

  for (const keyword of keywords) {
    if (haystack.includes(keyword)) count += 1;
  }

  return count;
}

function unique(arr = []) {
  return [...new Set(arr.filter(Boolean))];
}

function findDatesInText(text = "") {
  const results = [];

  const isoMatches = text.match(/\b(20\d{2})[-\/](0?[1-9]|1[0-2])[-\/](0?[1-9]|[12]\d|3[01])\b/g) || [];
  for (const m of isoMatches) {
    results.push(m.replace(/\//g, "-"));
  }

  const arabicDateMatches = text.match(/\b([0-3]?\d)[\/\-]([0-1]?\d)[\/\-](20\d{2})\b/g) || [];
  for (const m of arabicDateMatches) {
    const [d, mo, y] = m.split(/[\/\-]/);
    results.push(`${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }

  return unique(results);
}

function pickMostRecentDate(dateCandidates = []) {
  const valid = dateCandidates
    .map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());

  return valid.length ? valid[0].toISOString().slice(0, 10) : "";
}

function scoreRecencyByDate(dateString = "") {
  if (!dateString) return 0;

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return 0;

  const now = Date.now();
  const diffDays = Math.floor((now - date.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays <= 7) return 20;
  if (diffDays <= 30) return 16;
  if (diffDays <= 90) return 12;
  if (diffDays <= 180) return 8;
  if (diffDays <= 365) return 4;
  return 1;
}

function pickMainHtmlText($) {
  const selectors = [
    "main",
    "article",
    "[role='main']",
    ".content",
    ".article",
    ".article-content",
    ".article-body",
    ".post-content",
    ".entry-content",
    ".main-content",
    "#content"
  ];

  for (const selector of selectors) {
    const el = $(selector).first();
    const text = el.text()?.trim();
    if (text && text.length > 300) return text;
  }

  return $("body").text() || "";
}

function buildSearchQueries(query, ruleResult) {
  const queries = [
    `${query} نص النظام السعودي مادة`,
    `${query} شرح قانوني`,
    `${query} دراسة قانونية`,
    `${query} تحديث قانوني`,
    `${query} آخر تعديل`,
    `${query} filetype:pdf`
  ];

  if (ruleResult?.triggered && ruleResult.correctedCharacterization) {
    queries.push(`${ruleResult.correctedCharacterization} نص نظامي`);
    queries.push(`${ruleResult.correctedCharacterization} شرح قانوني سعودي`);
  }

  return unique(queries);
}

/* ====== البحث عبر Serper ====== */
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
      queryUsed: query
    }))
    .filter((r) => r.url);
}

/* ====== ترتيب النتائج ====== */
function scoreSearchResult(result, userQuery, ruleResult) {
  const keywords = extractKeywords(userQuery);
  let score = getBaseSourceWeight(result.url);

  score += countKeywordMatches(result.title, keywords) * 7;
  score += countKeywordMatches(result.snippet, keywords) * 4;

  const combined = `${result.title} ${result.snippet}`.toLowerCase();

  if (combined.includes("نظام")) score += 6;
  if (combined.includes("لائحة")) score += 5;
  if (combined.includes("مادة")) score += 7;
  if (combined.includes("تحديث")) score += 5;
  if (combined.includes("آخر تعديل")) score += 5;
  if (result.url.toLowerCase().endsWith(".pdf")) score += 3;

  const dateCandidates = findDatesInText(`${result.title} ${result.snippet}`);
  const mostRecent = pickMostRecentDate(dateCandidates);
  score += scoreRecencyByDate(mostRecent);

  if (ruleResult?.prioritySources?.length) {
    const category = getSourceCategory(result.url);
    if (ruleResult.prioritySources.includes(category)) {
      score += 8;
    }
  }

  return score;
}

/* ====== استخراج النص والتاريخ ====== */
async function extractTextAndMeta(url) {
  const { controller, clear } = buildAbortController();

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      },
      signal: controller.signal
    });

    if (!resp.ok) {
      return {
        text: "",
        extractedDate: "",
        contentType: "",
        sourceLabel: classifySourceLabel(url)
      };
    }

    const contentType = resp.headers.get("content-type") || "";
    const lastModifiedHeader = resp.headers.get("last-modified") || "";
    const buffer = await resp.arrayBuffer();

    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      const parsed = await pdf(Buffer.from(buffer));
      const pdfText = cleanText(parsed.text || "").slice(0, MAX_CHARS_PER_SOURCE);

      const dates = unique([
        ...findDatesInText(pdfText.slice(0, 3000)),
        ...findDatesInText(url)
      ]);

      return {
        text: pdfText,
        extractedDate: pickMostRecentDate([
          ...dates,
          lastModifiedHeader ? new Date(lastModifiedHeader).toISOString().slice(0, 10) : ""
        ]),
        contentType,
        sourceLabel: classifySourceLabel(url)
      };
    }

    const html = Buffer.from(buffer).toString("utf8");
    const $ = cheerio.load(html);

    $("script, style, nav, footer, header, aside, noscript, iframe, form").remove();

    const rawText = pickMainHtmlText($);
    const text = cleanText(rawText).slice(0, MAX_CHARS_PER_SOURCE);

    const metaCandidates = [
      $("meta[property='article:published_time']").attr("content") || "",
      $("meta[property='article:modified_time']").attr("content") || "",
      $("meta[name='pubdate']").attr("content") || "",
      $("meta[name='publish-date']").attr("content") || "",
      $("meta[name='date']").attr("content") || "",
      $("time").first().attr("datetime") || "",
      lastModifiedHeader ? new Date(lastModifiedHeader).toISOString().slice(0, 10) : "",
      ...findDatesInText(html.slice(0, 5000)),
      ...findDatesInText(text.slice(0, 3000))
    ];

    return {
      text,
      extractedDate: pickMostRecentDate(metaCandidates),
      contentType,
      sourceLabel: classifySourceLabel(url)
    };
  } catch {
    return {
      text: "",
      extractedDate: "",
      contentType: "",
      sourceLabel: classifySourceLabel(url)
    };
  } finally {
    clear();
  }
}

/* ====== OpenAI ====== */
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

function safeParseJSON(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();

  return JSON.parse(cleaned);
}

async function callOpenAI({ input, max_output_tokens = 2500, model = "gpt-4.1" }) {
  const openaiResp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      input,
      max_output_tokens
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

  return data;
}

/* ====== بناء نص المصادر ====== */
function buildSourcesText(sources) {
  return sources
    .map((s, i) => {
      return `
[المصدر ${i + 1}]
التصنيف: ${s.sourceLabel}
العنوان: ${s.title}
الرابط: ${s.url}
الملخص: ${s.snippet}
آخر تحديث أو تاريخ ظاهر: ${s.extractedDate || "غير ظاهر"}
النص:
${s.text || "لم يمكن استخراج نص كافٍ."}
`;
    })
    .join("\n---------------------\n");
}

/* ====== برومبت التحقق ====== */
function buildValidationPrompt(query, sourcesText, ruleResult) {
  return `
السؤال الأصلي:
${query}

نتيجة القواعد القانونية الصريحة:
${JSON.stringify(ruleResult, null, 2)}

المصادر المتاحة:
${sourcesText}

أنت مدقق قانوني سعودي صارم. مهمتك ليست الجواب النهائي، بل التحقق من التوصيف القانوني في السؤال، مع الالتزام بالقواعد القانونية الصريحة الواردة أعلاه.

قواعد إلزامية:
- إذا كانت القواعد القانونية الصريحة قد حددت أن هناك مصطلحًا يحتاج إعادة تكييف، فلا يجوز لك اعتباره صحيحًا تلقائيًا.
- إذا كانت القواعد قد حجبت مسارًا قانونيًا معينًا، فلا يجوز إعادة فتحه إلا إذا ظهر في المصادر الرسمية نص صريح جدًا يناقض القاعدة.
- لا يكفي ورود مصطلح قانوني في السؤال لتطبيق أحكامه.
- يجب فحص نوع العقد والواقعة وشروط الانطباق.
- افحص حداثة المصادر الظاهرة أيضًا.
- رتّب المصادر عند التعارض:
  1) النص الرسمي الأحدث
  2) الأكاديمي
  3) المقالات المهنية
  4) إكس/تويتر كمصدر مهني حديث مهم
  5) تيك توك وبقية المصادر

أخرج JSON فقط بالشكل التالي:

{
  "question_summary": "",
  "validation": {
    "is_question_terminology_precise": true,
    "problematic_terms": [],
    "premise_problem": false,
    "premise_problem_explanation": ""
  },
  "rule_gate": {
    "must_follow_hard_rules": true,
    "user_term_legally_applicable": true,
    "must_exclude_term_based_rules": false,
    "excluded_rules_or_paths": [],
    "why_excluded": "",
    "correct_legal_characterization": "",
    "allowed_rule_paths": []
  },
  "recency_review": {
    "latest_official_source_date": "",
    "latest_academic_source_date": "",
    "latest_professional_article_date": "",
    "latest_twitter_source_date": "",
    "recency_notes": ""
  }
}

أعد JSON صالحًا فقط.
`;
}

/* ====== برومبت الجواب النهائي ====== */
function buildFinalAnswerPrompt(originalQuery, effectiveQuery, sourcesText, ruleResult, gate) {
  return `
السؤال الأصلي:
${originalQuery}

السؤال بعد تطبيق القواعد القانونية الصريحة:
${effectiveQuery}

نتيجة القواعد القانونية الصريحة:
${JSON.stringify(ruleResult, null, 2)}

نتيجة بوابة التحقق:
${JSON.stringify(gate, null, 2)}

المصادر:
${sourcesText}

أنت باحث قانوني سعودي. اكتب الجواب النهائي بناءً على:
1) القواعد القانونية الصريحة
2) بوابة التحقق
3) المصادر

قواعد إلزامية:
- القواعد القانونية الصريحة مقدمة على ظاهر ألفاظ المستخدم.
- إذا كانت القواعد قد منعت مسارًا قانونيًا، فلا تطبقه.
- إذا كان السؤال يحتوي على توصيف يحتاج تصحيحًا، فابدأ بتصحيحه.
- إذا كانت عبارة المستخدم غير دقيقة، فقل ذلك صراحة.
- رجّح النص الرسمي الأحدث عند وجوده.
- بعده الأكاديمي، ثم المقالات المهنية، ثم إكس/تويتر كمصدر مهني حديث مهم.
- لا تعامل إكس/تويتر كمصدر ضعيف، لكن لا تقدمه على نص رسمي صريح عند التعارض.
- لا تستخدم الأحكام المحجوبة في blockedTerms أو excluded_rules_or_paths.
- لا تذكر أي مادة أو نتيجة فقط لأن لفظها ورد في السؤال.

هيكل الجواب:

<h2>عنوان الموضوع</h2>

<h3>فحص توصيف السؤال</h3>
<p>...</p>

<h3>التكييف القانوني الصحيح</h3>
<p>...</p>

<h3>الأساس النظامي أو المرجعي</h3>
<p>...</p>

<h3>مراعاة آخر التحديثات والمصادر الأحدث</h3>
<p>...</p>

<h3>التحليل القانوني</h3>
<ul>
<li>...</li>
<li>...</li>
</ul>

<h3>الخلاصة</h3>
<p>...</p>

<h3>المراجع</h3>
<ul>
<li><a href="..." target="_blank" rel="noopener noreferrer">اسم المصدر</a></li>
</ul>

إذا كانت القواعد القانونية الصريحة قد أشارت إلى إعادة تكييف، فلا تقل إن السؤال دقيق من الأصل دون معالجة ذلك.
`;
}

function buildFallbackHtml(query, sources, ruleResult = null) {
  const refs = sources
    .slice(0, 8)
    .map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a></li>`)
    .join("");

  return `
<h2>إجابة قانونية أولية</h2>
<h3>فحص توصيف السؤال</h3>
<p>${escapeHtml(ruleResult?.warning || "تمت معالجة السؤال ضمن المتاح من المصادر.")}</p>
<h3>الخلاصة</h3>
<p>${escapeHtml(query)}</p>
<h3>المراجع</h3>
<ul>${refs}</ul>
`;
}

/* ====== الخادم ====== */
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
    /* 1) تطبيق القواعد القانونية الصريحة أولًا */
    const ruleResult = applyLegalRules(query);
    const effectiveQuery = ruleResult?.correctedQuery || query;

    /* 2) البحث بناء على السؤال بعد إعادة التكييف */
    const searchQueries = buildSearchQueries(effectiveQuery, ruleResult);
    const resultsArrays = await Promise.all(searchQueries.map((q) => serperSearch(q)));

    let allResults = dedupeSources(resultsArrays.flat())
      .map((r) => ({
        ...r,
        initialScore: scoreSearchResult(r, effectiveQuery, ruleResult)
      }))
      .sort((a, b) => b.initialScore - a.initialScore)
      .slice(0, MAX_SOURCES);

    if (!allResults.length) {
      return res.status(200).json({
        content: "<p>تعذر العثور على نتائج كافية في المصادر القانونية المحددة.</p>",
        sources: [],
        type: "إجابة قانونية",
        meta: {
          ruleResult,
          searchQueries
        }
      });
    }

    /* 3) استخراج النصوص والتواريخ */
    const extracted = [];
    for (const r of allResults) {
      const meta = await extractTextAndMeta(r.url);
      extracted.push({
        ...r,
        ...meta
      });
    }

    /* 4) ترتيب نهائي بعد الاستخراج */
    const filteredSources = extracted
      .filter((s) => s.text && s.text.length >= 120)
      .map((s) => {
        let finalScore = s.initialScore || 0;
        finalScore += scoreRecencyByDate(s.extractedDate);
        finalScore += countKeywordMatches(
          `${s.title} ${s.snippet} ${s.text.slice(0, 1500)}`,
          extractKeywords(effectiveQuery)
        ) * 2;

        if (ruleResult?.prioritySources?.length) {
          const category = getSourceCategory(s.url);
          if (ruleResult.prioritySources.includes(category)) {
            finalScore += 6;
          }
        }

        return {
          ...s,
          finalScore
        };
      })
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, 12);

    if (!filteredSources.length) {
      return res.status(200).json({
        content: "<p>تم العثور على نتائج، لكن تعذر استخراج نصوص قانونية كافية للتحليل.</p>",
        sources: allResults,
        type: "إجابة قانونية",
        meta: {
          ruleResult,
          searchQueries
        }
      });
    }

    const sourcesText = buildSourcesText(filteredSources);

    /* 5) بوابة تحقق مرتبطة بالقواعد */
    let gate;
    try {
      const validationData = await callOpenAI({
        input: buildValidationPrompt(query, sourcesText, ruleResult),
        max_output_tokens: 1800,
        model: "gpt-4.1"
      });

      gate = safeParseJSON(extractOpenAIText(validationData));
    } catch {
      gate = {
        question_summary: query,
        validation: {
          is_question_terminology_precise: !ruleResult?.triggered,
          problematic_terms: ruleResult?.blockedTerms || [],
          premise_problem: !!ruleResult?.triggered,
          premise_problem_explanation: ruleResult?.warning || ""
        },
        rule_gate: {
          must_follow_hard_rules: true,
          user_term_legally_applicable: !(ruleResult?.blockedTerms?.length),
          must_exclude_term_based_rules: !!(ruleResult?.blockedTerms?.length),
          excluded_rules_or_paths: ruleResult?.blockedTerms || [],
          why_excluded: ruleResult?.explanation || "",
          correct_legal_characterization: ruleResult?.correctedCharacterization || "",
          allowed_rule_paths: ruleResult?.appliedRules || []
        },
        recency_review: {
          latest_official_source_date: "",
          latest_academic_source_date: "",
          latest_professional_article_date: "",
          latest_twitter_source_date: "",
          recency_notes: ""
        }
      };
    }

    /* 6) الجواب النهائي */
    let content = "";
    try {
      const finalData = await callOpenAI({
        input: buildFinalAnswerPrompt(query, effectiveQuery, sourcesText, ruleResult, gate),
        max_output_tokens: 3000,
        model: "gpt-4.1"
      });
      content = extractOpenAIText(finalData);
    } catch {
      content = "";
    }

    if (!content || !content.trim()) {
      content = buildFallbackHtml(query, filteredSources, ruleResult);
    }

    return res.status(200).json({
      content,
      sources: filteredSources.map((s) => ({
        title: s.title,
        url: s.url,
        snippet: s.snippet,
        sourceType: s.sourceLabel,
        extractedDate: s.extractedDate || ""
      })),
      type: "إجابة قانونية",
      meta: {
        originalQuery: query,
        effectiveQuery,
        searchQueries,
        totalResults: allResults.length,
        extractedResults: filteredSources.length,
        ruleResult,
        validationGate: gate
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "خطأ غير متوقع"
    });
  }
}
