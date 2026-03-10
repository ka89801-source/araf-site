import * as cheerio from "cheerio";
import pdf from "pdf-parse";
import { applyLegalRules } from "../lib/legalRules.js";

/* ====== إعدادات ====== */
const MAX_RESULTS_PER_SEARCH = 8;
const MAX_SOURCES = 24;
const MAX_CHARS_PER_SOURCE = 7000;
const FETCH_TIMEOUT_MS = 15000;

/* ====== فلترة البحث الأولية ======
مقصودها توسيع المجال داخل السياق السعودي:
- رسمي سعودي
- جامعات سعودية
- صحف/منصات سعودية
- X / Twitter
- LinkedIn
- TikTok
*/
const DOMAIN_FILTER = `
(site:gov.sa OR
site:edu.sa OR
site:x.com OR
site:twitter.com OR
site:linkedin.com OR
site:tiktok.com OR
site:sa)
`;

/* ====== أدوات عامة ====== */
function getHostname(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

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
    if (!r?.url) continue;

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
  return String(text)
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
    "بشأن", "بخصوص", "بعد", "قبل", "عند", "ضمن", "فيه", "فيها", "كان", "كانت",
    "لقد", "قد", "الى", "الي", "عنها", "عنه", "عليها", "عليه"
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

/* ====== تصنيف المصدر ====== */
function getSourceCategory(url = "") {
  const host = getHostname(url);

  if (
    host.endsWith(".gov.sa") ||
    host === "gov.sa" ||
    host === "laws.boe.gov.sa" ||
    host.endsWith(".boe.gov.sa")
  ) {
    return "official";
  }

  if (host.endsWith(".edu.sa") || host === "edu.sa") {
    return "academic";
  }

  if (host.includes("linkedin.com")) {
    return "linkedin";
  }

  if (host.includes("x.com") || host.includes("twitter.com")) {
    return "twitter";
  }

  if (host.includes("tiktok.com")) {
    return "tiktok";
  }

  if (host.endsWith(".sa") || host === "sa") {
    return "saudi_site";
  }

  return "other";
}

function classifySourceLabel(url = "") {
  switch (getSourceCategory(url)) {
    case "official":
      return "رسمي سعودي";
    case "academic":
      return "أكاديمي سعودي";
    case "linkedin":
      return "لينكدإن مهني";
    case "twitter":
      return "إكس / تويتر";
    case "tiktok":
      return "تيك توك";
    case "saudi_site":
      return "موقع سعودي";
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
      return 90;
    case "saudi_site":
      return 82;
    case "linkedin":
      return 80;
    case "twitter":
      return 78;
    case "tiktok":
      return 70;
    default:
      return 50;
  }
}

/* ====== فلترة سعودية ذكية ======
لا يكفي أن يكون الموقع رسميًا.
المهم:
- سعودي الدومين أو سعودي الصلة
- متعلق بالقانون أو الأنظمة أو السعودية
*/
function isSaudiRelevant(result) {
  const combined = `${result.title || ""} ${result.snippet || ""} ${result.url || ""}`.toLowerCase();

  const saudiKeywords = [
    "السعودية",
    "المملكه العربيه السعوديه",
    "المملكة العربية السعودية",
    "saudi",
    "ksa",
    "saudi arabia",
    "نظام العمل السعودي",
    "نظام سعودي",
    "وزارة الموارد البشرية",
    "وزارة العدل",
    "وزارة التجاره",
    "وزارة التجارة",
    "ديوان المظالم",
    "هيئة الخبراء",
    "الرياض",
    "جدة",
    "الدمام",
    "الخبر",
    "المحكمة",
    "المحاكم السعودية",
    ".gov.sa",
    ".edu.sa",
    ".sa"
  ];

  return saudiKeywords.some((k) => combined.includes(k.toLowerCase()));
}

function isBlockedForeignContext(result) {
  const combined = `${result.title || ""} ${result.snippet || ""}`.toLowerCase();

  const blockedCountryIndicators = [
    "الكويت",
    "الكويتي",
    "kuwait",
    "فلسطين",
    "palestine",
    "الأردن",
    "jordan",
    "مصر",
    "egypt",
    "العراق",
    "iraq",
    "لبنان",
    "lebanon",
    "تونس",
    "tunisia",
    "الجزائر",
    "algeria",
    "المغرب",
    "morocco",
    "الإمارات",
    "uae",
    "قطر",
    "qatar",
    "البحرين",
    "bahrain",
    "عمان",
    "oman"
  ];

  return blockedCountryIndicators.some((k) => combined.includes(k));
}

function filterSaudiResults(results) {
  return results.filter((r) => {
    const host = getHostname(r.url);
    const category = getSourceCategory(r.url);

    const isSaudiDomain =
      category === "official" ||
      category === "academic" ||
      category === "saudi_site";

    const isGeneralPlatform =
      category === "twitter" ||
      category === "linkedin" ||
      category === "tiktok";

    if (isBlockedForeignContext(r) && !isSaudiRelevant(r)) {
      return false;
    }

    if (isSaudiDomain) return true;

    if (isGeneralPlatform) {
      return isSaudiRelevant(r);
    }

    return isSaudiRelevant(r);
  });
}

/* ====== البحث ======
البحث يعتمد على السؤال الأصلي فقط
ولا يستخدم السؤال المصحح قانونيًا حتى لا تتلوث النتائج
*/
function buildSearchQueries(originalQuery) {
  return unique([
    `${originalQuery} نص النظام السعودي مادة`,
    `${originalQuery} شرح قانوني سعودي`,
    `${originalQuery} دراسة قانونية سعودية`,
    `${originalQuery} تحديث قانوني سعودي`,
    `${originalQuery} آخر تعديل سعودي`,
    `${originalQuery} filetype:pdf السعودية قانوني`
  ]);
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

  if (isSaudiRelevant(result)) score += 6;
  if (isBlockedForeignContext(result) && !isSaudiRelevant(result)) score -= 30;

  return score;
}

/* ====== استخراج النص ====== */
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
function buildValidationPrompt(originalQuery, sourcesText, ruleResult) {
  return `
السؤال الأصلي:
${originalQuery}

نتيجة القواعد القانونية الصريحة:
${JSON.stringify(ruleResult, null, 2)}

المصادر:
${sourcesText}

أنت مدقق قانوني سعودي صارم.

مهمتك:
1) فحص هل السؤال كما صيغ دقيق قانونيًا أم يحتاج تصحيح.
2) الالتزام بالقواعد القانونية الصريحة أعلاه.
3) عدم السماح بتمرير أي توصيف محجوب أو غير منطبق.
4) ملاحظة حداثة المصادر.

قواعد إلزامية:
- إذا كانت القواعد القانونية الصريحة قد قررت أن هناك مصطلحًا يحتاج إعادة تكييف، فلا يجوز اعتبار السؤال دقيقًا بصيغته الأصلية.
- لا يكفي ورود لفظ قانوني في السؤال لتطبيق أحكامه.
- إذا كانت القواعد قد حجبت مسارًا قانونيًا، فلا يجوز إعادة فتحه إلا إذا ظهر نص رسمي سعودي صريح جدًا يناقضه.
- عند التعارض: الرسمي الأحدث أولًا، ثم الأكاديمي السعودي، ثم المقالات المهنية السعودية، ثم إكس/تويتر السعودي، ثم لينكدإن، ثم تيك توك.

أخرج JSON فقط بالشكل التالي:

{
  "validation": {
    "is_question_terminology_precise": true,
    "premise_problem": false,
    "premise_problem_explanation": "",
    "must_rephrase_question_legally": false,
    "legal_rephrased_question": ""
  },
  "rule_gate": {
    "must_follow_hard_rules": true,
    "must_exclude_term_based_rules": false,
    "excluded_rules_or_paths": [],
    "why_excluded": "",
    "correct_legal_characterization": ""
  },
  "recency_review": {
    "latest_official_source_date": "",
    "latest_academic_source_date": "",
    "latest_professional_source_date": "",
    "latest_twitter_source_date": "",
    "recency_notes": ""
  }
}

أعد JSON صالحًا فقط.
`;
}

/* ====== برومبت الجواب النهائي ====== */
function buildFinalAnswerPrompt(originalQuery, legalRephrasedQuestion, sourcesText, ruleResult, gate) {
  return `
السؤال الأصلي:
${originalQuery}

الصياغة القانونية المصححة الواجبة الاعتماد:
${legalRephrasedQuestion}

نتيجة القواعد القانونية الصريحة:
${JSON.stringify(ruleResult, null, 2)}

نتيجة بوابة التحقق:
${JSON.stringify(gate, null, 2)}

المصادر:
${sourcesText}

أنت باحث قانوني سعودي.

قواعد إلزامية:
- لا تجب على السؤال بصيغته الأصلية إذا كانت صياغته القانونية غير دقيقة.
- يجب أن تبدأ الجواب بتوضيح الخلل في التوصيف، ثم إعادة صياغة السؤال بالصيغة القانونية الصحيحة، ثم الجواب بناء على الصيغة المصححة.
- إذا حظرت القواعد مسارًا قانونيًا، فلا تطبقه.
- لا تطبق أحكام أي مصطلح لمجرد وروده في السؤال.
- رجح النص الرسمي السعودي الأحدث، ثم الأكاديمي السعودي، ثم المقالات المهنية السعودية، ثم إكس/تويتر السعودي كمصدر مهني حديث مهم.
- لا تجعل الجواب يبدو وكأنه وافق على صياغة المستخدم إن كانت خاطئة.

الهيكل الإلزامي:

<h2>عنوان الموضوع</h2>

<h3>تصحيح صياغة السؤال</h3>
<p>
ابدأ بعبارة صريحة تبين أن السؤال بصيغته الأصلية يحتاج تصحيحًا إن كان كذلك،
ثم اكتب الصياغة القانونية الصحيحة للمسألة.
</p>

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

مهم جدًا:
- إذا كان السؤال يحتاج تصحيحًا، فلا تقل إن المصطلحات الواردة فيه دقيقة.
- يجب أن يظهر التصحيح نفسه داخل الجواب النهائي بوضوح.
- لا تستخدم تعبيرات داخلية مثل "تنبيه داخلي" أو "قواعد داخلية" في الجواب.
- الجواب بصيغة HTML فقط.
`;
}

function buildFallbackHtml(originalQuery, legalRephrasedQuestion, sources, ruleResult = null) {
  const refs = sources
    .slice(0, 8)
    .map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a></li>`)
    .join("");

  return `
<h2>إجابة قانونية أولية</h2>
<h3>تصحيح صياغة السؤال</h3>
<p>${escapeHtml(
    legalRephrasedQuestion && legalRephrasedQuestion !== originalQuery
      ? `الصياغة القانونية الأدق للمسألة هي: ${legalRephrasedQuestion}`
      : ruleResult?.warning || "تمت معالجة السؤال ضمن المتاح من المصادر."
  )}</p>
<h3>الخلاصة</h3>
<p>${escapeHtml(originalQuery)}</p>
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
    /* 1) تطبيق القواعد القانونية الصريحة */
    const ruleResult = applyLegalRules(query);

    /* 2) البحث يكون بالسؤال الأصلي فقط */
    const searchQueries = buildSearchQueries(query);
    const resultsArrays = await Promise.all(searchQueries.map((q) => serperSearch(q)));

    let allResults = filterSaudiResults(
      dedupeSources(resultsArrays.flat())
    )
      .map((r) => ({
        ...r,
        initialScore: scoreSearchResult(r, query, ruleResult)
      }))
      .sort((a, b) => b.initialScore - a.initialScore)
      .slice(0, MAX_SOURCES);

    if (!allResults.length) {
      return res.status(200).json({
        content: "<p>تعذر العثور على نتائج كافية في المصادر القانونية السعودية أو المتعلقة بالسياق السعودي.</p>",
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

    /* 4) فلترة ثانية بعد الاستخراج لضمان الصلة السعودية */
    const filteredSources = extracted
      .filter((s) => s.text && s.text.length >= 120)
      .filter((s) => {
        const pseudoResult = {
          title: s.title,
          snippet: `${s.snippet} ${s.text.slice(0, 1200)}`,
          url: s.url
        };

        return filterSaudiResults([pseudoResult]).length > 0;
      })
      .map((s) => {
        let finalScore = s.initialScore || 0;
        finalScore += scoreRecencyByDate(s.extractedDate);
        finalScore += countKeywordMatches(
          `${s.title} ${s.snippet} ${s.text.slice(0, 1500)}`,
          extractKeywords(query)
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
        content: "<p>تم العثور على نتائج أولية، لكن تعذر استخراج نصوص سعودية كافية ومرتبطة بالسؤال للتحليل.</p>",
        sources: allResults,
        type: "إجابة قانونية",
        meta: {
          ruleResult,
          searchQueries
        }
      });
    }

    const sourcesText = buildSourcesText(filteredSources);

    /* 5) بوابة التحقق */
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
        validation: {
          is_question_terminology_precise: !ruleResult?.triggered,
          premise_problem: !!ruleResult?.triggered,
          premise_problem_explanation: ruleResult?.warning || "",
          must_rephrase_question_legally: !!ruleResult?.triggered,
          legal_rephrased_question: ruleResult?.correctedCharacterization || query
        },
        rule_gate: {
          must_follow_hard_rules: true,
          must_exclude_term_based_rules: !!(ruleResult?.blockedTerms?.length),
          excluded_rules_or_paths: ruleResult?.blockedTerms || [],
          why_excluded: ruleResult?.explanation || "",
          correct_legal_characterization: ruleResult?.correctedCharacterization || ""
        },
        recency_review: {
          latest_official_source_date: "",
          latest_academic_source_date: "",
          latest_professional_source_date: "",
          latest_twitter_source_date: "",
          recency_notes: ""
        }
      };
    }

    const legalRephrasedQuestion =
      gate?.validation?.legal_rephrased_question ||
      ruleResult?.correctedCharacterization ||
      query;

    /* 6) الجواب النهائي */
    let content = "";
    try {
      const finalData = await callOpenAI({
        input: buildFinalAnswerPrompt(query, legalRephrasedQuestion, sourcesText, ruleResult, gate),
        max_output_tokens: 3000,
        model: "gpt-4.1"
      });
      content = extractOpenAIText(finalData);
    } catch {
      content = "";
    }

    if (!content || !content.trim()) {
      content = buildFallbackHtml(query, legalRephrasedQuestion, filteredSources, ruleResult);
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
        legalRephrasedQuestion,
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
