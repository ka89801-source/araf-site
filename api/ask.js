import * as cheerio from "cheerio";
import pdf from "pdf-parse";

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

/* ====== أوزان المصادر ======
1) رسمي
2) أكاديمي
3) مقالات/محتوى مهني
4) تويتر/إكس
5) تيك توك / بقية الاجتماعي
*/
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

function unique(arr = []) {
  return [...new Set(arr.filter(Boolean))];
}

function dedupeSources(arr) {
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
    "بشأن", "بخصوص", "بعد", "قبل", "عند", "عندها", "ضمن", "على", "فيه", "فيها"
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

function scoreRecencyByDate(dateString) {
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

function findDatesInText(text = "") {
  const results = [];

  const isoMatches = text.match(/\b(20\d{2})[-\/](0?[1-9]|1[0-2])[-\/](0?[1-9]|[12]\d|3[01])\b/g) || [];
  for (const m of isoMatches) {
    const normalized = m.replace(/\//g, "-");
    results.push(normalized);
  }

  const arabicDateMatches = text.match(/\b([0-3]?\d)[\/\-]([0-1]?\d)[\/\-](20\d{2})\b/g) || [];
  for (const m of arabicDateMatches) {
    const [d, mo, y] = m.split(/[\/\-]/);
    const dd = String(d).padStart(2, "0");
    const mm = String(mo).padStart(2, "0");
    results.push(`${y}-${mm}-${dd}`);
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

function buildSearchQueries(query) {
  return [
    `${query} نص النظام السعودي مادة`,
    `${query} شرح قانوني`,
    `${query} دراسة قانونية`,
    `${query} تحديث قانوني`,
    `${query} آخر تعديل`,
    `${query} filetype:pdf`
  ];
}

/* ====== تنفيذ بحث عبر Serper ====== */
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

/* ====== ترتيب النتائج الأولي ====== */
function scoreSearchResult(result, userQuery) {
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

/* ====== استخراج نص رد OpenAI ====== */
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

/* ====== استدعاء OpenAI ====== */
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

/* ====== بوابة التحقق القانوني ====== */
function buildValidationPrompt(query, sourcesText) {
  return `
السؤال:
${query}

المصادر المتاحة:
${sourcesText}

أنت مدقق قانوني سعودي صارم. مهمتك ليست الجواب النهائي، بل التحقق من صحة التوصيف القانوني في السؤال قبل أي استدلال.

مهم جدًا:
- لا يكفي ورود مصطلح قانوني في السؤال لتطبيق أحكامه.
- يجب التحقق أولًا من شروط انطباق هذا المصطلح على الوقائع المذكورة.
- إذا كان في السؤال وصف غير دقيق أو فرضية خاطئة أو خلط بين مفاهيم، فيجب كشف ذلك صراحة.
- يجب أيضًا فحص حداثة المصادر الظاهرة، وتحديد إن كان هناك مصدر أحدث ظاهر ينبغي ترجيحه.
- عند التعارض:
  1) النص الرسمي الأحدث أولًا
  2) الأكاديمي
  3) المقالات المهنية
  4) إكس/تويتر كمصدر مهني حديث مهم
  5) غير ذلك
- لا تعامل إكس/تويتر كمصدر ضعيف تلقائيًا، بل كمصدر مهني حديث مهم، لكن لا يقدَّم على نص رسمي صريح عند التعارض.

أخرج JSON فقط بالشكل التالي تمامًا:

{
  "question_summary": "",
  "legal_elements": {
    "contract_type": "",
    "issue_type": "",
    "parties": "",
    "time_factor": "",
    "user_terms": []
  },
  "validation": {
    "is_question_terminology_precise": true,
    "problematic_terms": [],
    "premise_problem": false,
    "premise_problem_explanation": ""
  },
  "rule_gate": {
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
    "should_prioritize_recent_sources": true,
    "recency_notes": ""
  },
  "guidance_for_final_answer": {
    "must_correct_user_term_first": false,
    "must_warn_about_mischaracterization": false,
    "must_prioritize_newer_sources_when_relevant": true
  }
}

أعد JSON صالحًا فقط، بلا markdown.
`;
}

/* ====== برومبت الجواب النهائي ====== */
function buildFinalAnswerPrompt(query, sourcesText, gate) {
  return `
السؤال الأصلي:
${query}

نتيجة بوابة التحقق القانوني:
${JSON.stringify(gate, null, 2)}

المصادر:
${sourcesText}

أنت باحث قانوني سعودي. اكتب الجواب النهائي بناءً على بوابة التحقق أعلاه، لا على ظاهر ألفاظ المستخدم فقط.

قواعد إلزامية:
- إذا كانت بوابة التحقق قد قررت أن المصطلح المستخدم غير منطبق، فلا تطبق الأحكام المرتبطة به.
- إذا وجب استبعاد مسار قانوني معين، فاستبعده صراحة في الجواب.
- صحح التوصيف أولًا إذا لزم.
- رجّح النص الرسمي الأحدث عند وجوده.
- بعده الأكاديمي، ثم المقالات المهنية، ثم إكس/تويتر كمصدر حديث مهم.
- لا تُضعف قيمة إكس/تويتر تلقائيًا، لكن لا تقدمه على نص رسمي صريح عند التعارض.
- فرّق بين:
  1) النص النظامي
  2) التحليل المهني
  3) المستجد أو النقاش الحديث
- إذا كانت الحداثة مؤثرة في الجواب، فاذكر ذلك.
- اجعل الجواب بصيغة HTML فقط دون أي شيء خارج HTML.

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

إذا كان السؤال يحتوي على فرضية خاطئة، فابدأ بتصحيحها بوضوح.
`;
}

/* ====== fallback ====== */
function buildFallbackHtml(query, sources, gate = null) {
  const refs = sources
    .slice(0, 8)
    .map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a></li>`)
    .join("");

  return `
<h2>إجابة قانونية أولية</h2>
<h3>فحص توصيف السؤال</h3>
<p>${gate?.validation?.premise_problem ? escapeHtml(gate.validation.premise_problem_explanation || "يوجد احتمال وجود خلل في توصيف السؤال.") : "تمت معالجة السؤال ضمن المتاح من المصادر."}</p>
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
    const searchQueries = buildSearchQueries(query);
    const resultsArrays = await Promise.all(searchQueries.map((q) => serperSearch(q)));

    let allResults = dedupeSources(resultsArrays.flat())
      .map((r) => ({
        ...r,
        initialScore: scoreSearchResult(r, query)
      }))
      .sort((a, b) => b.initialScore - a.initialScore)
      .slice(0, MAX_SOURCES);

    if (!allResults.length) {
      return res.status(200).json({
        content: "<p>تعذر العثور على نتائج كافية في المصادر القانونية المحددة.</p>",
        sources: [],
        type: "إجابة قانونية"
      });
    }

    const extracted = [];
    for (const r of allResults) {
      const meta = await extractTextAndMeta(r.url);
      extracted.push({
        ...r,
        ...meta
      });
    }

    const filteredSources = extracted
      .filter((s) => s.text && s.text.length >= 120)
      .map((s) => {
        let finalScore = s.initialScore || 0;
        finalScore += scoreRecencyByDate(s.extractedDate);
        finalScore += countKeywordMatches(`${s.title} ${s.snippet} ${s.text.slice(0, 1500)}`, extractKeywords(query)) * 2;
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
        type: "إجابة قانونية"
      });
    }

    const sourcesText = buildSourcesText(filteredSources);

    let gate;
    try {
      const validationData = await callOpenAI({
        input: buildValidationPrompt(query, sourcesText),
        max_output_tokens: 1800,
        model: "gpt-4.1"
      });
      gate = safeParseJSON(extractOpenAIText(validationData));
    } catch {
      gate = {
        question_summary: query,
        legal_elements: {
          contract_type: "",
          issue_type: "",
          parties: "",
          time_factor: "",
          user_terms: []
        },
        validation: {
          is_question_terminology_precise: true,
          problematic_terms: [],
          premise_problem: false,
          premise_problem_explanation: ""
        },
        rule_gate: {
          user_term_legally_applicable: true,
          must_exclude_term_based_rules: false,
          excluded_rules_or_paths: [],
          why_excluded: "",
          correct_legal_characterization: "",
          allowed_rule_paths: []
        },
        recency_review: {
          latest_official_source_date: "",
          latest_academic_source_date: "",
          latest_professional_article_date: "",
          latest_twitter_source_date: "",
          should_prioritize_recent_sources: true,
          recency_notes: ""
        },
        guidance_for_final_answer: {
          must_correct_user_term_first: false,
          must_warn_about_mischaracterization: false,
          must_prioritize_newer_sources_when_relevant: true
        }
      };
    }

    let content = "";
    try {
      const finalData = await callOpenAI({
        input: buildFinalAnswerPrompt(query, sourcesText, gate),
        max_output_tokens: 2800,
        model: "gpt-4.1"
      });
      content = extractOpenAIText(finalData);
    } catch {
      content = "";
    }

    if (!content || !content.trim()) {
      content = buildFallbackHtml(query, filteredSources, gate);
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
        searchQueries,
        totalResults: allResults.length,
        extractedResults: filteredSources.length,
        validationGate: gate
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "خطأ غير متوقع"
    });
  }
}
