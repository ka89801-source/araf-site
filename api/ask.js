import * as cheerio from "cheerio";
import pdf from "pdf-parse";

/* ====================================================================
   منصة أعراف القانونية — Workflow Engine v4
   تحسينات:
   1) تفكيك السؤال الطويل والمعقد إلى مسائل فرعية
   2) تقليل استهلاك التوكن
   3) استخدام مقاطع مركزة بدل ضخ نصوص طويلة
   4) تحسين البحث للسؤال القانوني السعودي
   ==================================================================== */

/* ====== إعدادات عامة ====== */
const MAX_RESULTS_PER_SEARCH = 8;
const MAX_SOURCES = 18;
const MIN_SOURCES_TARGET = 6;
const MAX_RAW_CHARS_PER_SOURCE = 12000;
const MAX_EXCERPT_CHARS = 900;
const MAX_EXCERPTS_PER_LAYER = {
  official: 5,
  explanatory: 4,
  professional: 3
};

const OPENAI_MODEL = "gpt-4.1";

/* ====== طبقات المصادر ====== */
const OFFICIAL_DOMAINS = [
  "laws.boe.gov.sa", "boe.gov.sa", "moj.gov.sa", "hrsd.gov.sa",
  "mlsd.gov.sa", "mc.gov.sa", "gosi.gov.sa", "nazaha.gov.sa",
  "spa.gov.sa", "mci.gov.sa", "sjc.gov.sa", "zatca.gov.sa",
  "cma.org.sa", "sama.gov.sa"
];

const EXPLANATORY_DOMAINS = [
  "edu.sa", "ajel.sa", "sabq.org", "al-jazirah.com", "alyaum.com",
  "aleqt.com", "okaz.com.sa", "alriyadh.com", "alwatan.com.sa",
  "maaal.com", "argaam.com", "almowaten.net"
];

const PROFESSIONAL_DOMAINS = [
  "linkedin.com", "x.com", "twitter.com", "youtube.com"
];

/* ====== تنظيف السؤال ====== */
function cleanQuery(raw = "") {
  let q = String(raw).trim();
  q = q.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g, "");
  q = q.replace(/[أإآ]/g, "ا");
  q = q.replace(/ى/g, "ي");
  q = q.replace(/ة(?=\s|$)/g, "ه");
  q = q.replace(/\s+/g, " ").trim();
  return q;
}

/* ====== تصنيف نوع السؤال ====== */
function classifyQuestion(query) {
  const q = query || "";
  if (/صياغ|بند|عقد|نموذج|مراجع|مراجعه بند|اعادة صياغه/.test(q)) return "drafting";
  if (/ما حكم|هل يجوز|هل يحق|يستحق|يلزم|واجب|محظور|ممنوع|مادة\s*\d+/.test(q)) return "direct_ruling";
  if (/لائح|إجراء|متطلب|ترخيص|تسجيل|شرط|خطوات|اشتراطات|متطلبات/.test(q)) return "regulatory";
  if (/تفسير|معنى|المقصود|شرح|يقصد|دلاله|تأويل/.test(q)) return "interpretation";
  if (/حاله|واقع|موقف|تطبيق|عملي|لو ان|اذا كان|وقع|حصل|في حال/.test(q)) return "practical";
  if (/مقارن|فرق بين|تعارض|ايهما|الفرق|مقارنة/.test(q)) return "comparison";
  if (/راي|اجتهاد|وجهه نظر|ما راي/.test(q)) return "opinion";
  return "direct_ruling";
}

/* ====== استخراج الكلمات المفتاحية القانونية ====== */
function extractLegalKeywords(query) {
  const keywords = [];

  const articleMatches = query.match(/ماد[ةه]\s*(\d+)/g);
  if (articleMatches) keywords.push(...articleMatches);

  const legalTerms = query.match(
    /(فصل تعسفي|اجر اضافي|اجازه|مكافاه نهايه الخدمه|ساعات العمل|استقاله|عقد محدد المده|عقد غير محدد|فتره التجربه|انذار|تعويض|حقوق العامل|صاحب العمل|نقل كفاله|بدل سكن|بدل نقل|تامينات اجتماعيه|نظام العمل|نظام الشركات|نظام المعاملات المدنيه|نظام الاحوال الشخصيه|نظام التجاره|نظام المرافعات|نظام التنفيذ|نظام الافلاس|الشرط الجزائي|المخالصة|مخالصة نهائية|انهاء العقد|فسخ العقد|تعويض العامل|فترة الاشعار|الاجور|المستحقات|العمولات|الوكاله|الوكالات التجاريه|السجل التجاري|الترخيص|الامتياز التجاري|البيانات الشخصيه|الملكيه الفكريه)/g
  );
  if (legalTerms) keywords.push(...legalTerms);

  return [...new Set(keywords)];
}

/* ====== تفكيك السؤال الطويل والمعقد ====== */
function splitIntoSentences(text) {
  return text
    .split(/[\n\r]+|[؟?!؛]+|(?:\s-\s)|(?:\.\s+)/)
    .map(s => s.trim())
    .filter(Boolean);
}

function dedupeTextArray(arr) {
  return [...new Set(arr.map(x => x.trim()).filter(Boolean))];
}

function detectLikelyLaws(text) {
  const laws = [];
  const map = [
    ["نظام العمل", /نظام العمل|عامل|موظف|اجازه|اجر|فصل|استقاله|مكافاه|ساعات العمل|بدل|فتره التجربه|انهاء العقد/],
    ["نظام الشركات", /نظام الشركات|شركه|شريك|مجلس اداره|جمعيه|حصص|اسهم/],
    ["نظام المعاملات المدنية", /نظام المعاملات المدنيه|التزام|تعويض|فسخ|بطلان|مسؤوليه|خطا|ضرر/],
    ["نظام الأحوال الشخصية", /نظام الاحوال الشخصيه|حضانه|نفقه|طلاق|خلع|ولايه|زياره/],
    ["نظام التنفيذ", /نظام التنفيذ|سند تنفيذي|تنفيذ|حجز|افصاح/],
    ["نظام المرافعات الشرعية", /نظام المرافعات|دعوى|اختصاص|اجراءات قضائيه|تبليغ/],
    ["نظام الإفلاس", /نظام الافلاس|افلاس|اعسار|اعاده تنظيم مالي/],
    ["نظام التجارة", /نظام التجاره|تاجر|اوراق تجاريه|كمبياله|شيك|سند لامر/]
  ];
  for (const [name, rx] of map) {
    if (rx.test(text)) laws.push(name);
  }
  return laws;
}

function buildConciseQuestion(cleaned, keywords, subIssues) {
  const parts = [];
  if (keywords.length) parts.push(keywords.slice(0, 6).join(" "));
  if (subIssues.length) parts.push(subIssues.slice(0, 3).join(" | "));
  const base = parts.join(" | ").trim();
  if (base) return base.slice(0, 300);
  return cleaned.slice(0, 300);
}

function analyzeQuestionStructure(query) {
  const cleaned = cleanQuery(query);
  const sentences = splitIntoSentences(cleaned);
  const keywords = extractLegalKeywords(cleaned);

  const issueSignals = [
    "هل", "ما", "ماذا", "اذا", "في حال", "لو", "هل يحق", "هل يجوز",
    "يستحق", "يلزم", "تعويض", "فسخ", "انهاء", "مخالصة", "شرط جزائي",
    "مكافاه", "اجازه", "اختصاص", "اجراء", "ترخيص", "مسؤوليه", "بطلان"
  ];

  let subIssues = [];
  for (const sentence of sentences) {
    if (
      sentence.length >= 12 &&
      issueSignals.some(sig => sentence.includes(sig))
    ) {
      subIssues.push(sentence);
    }
  }

  if (subIssues.length === 0 && keywords.length) {
    subIssues = keywords.slice(0, 5).map(k => `المسألة المتعلقة بـ ${k}`);
  }

  subIssues = dedupeTextArray(subIssues).slice(0, 6);

  const questionTypes = dedupeTextArray([
    classifyQuestion(cleaned),
    /مادة|نص|حكم/.test(cleaned) ? "direct_ruling" : "",
    /تفسير|شرح|مقصود/.test(cleaned) ? "interpretation" : "",
    /اذا كان|في حال|وقع|حصل|عملي/.test(cleaned) ? "practical" : "",
    /فرق|مقارنة|تعارض/.test(cleaned) ? "comparison" : "",
    /صياغ|بند|عقد/.test(cleaned) ? "drafting" : ""
  ]).slice(0, 3);

  const likelyLaws = detectLikelyLaws(cleaned);
  const conciseQuestion = buildConciseQuestion(cleaned, keywords, subIssues);

  return {
    cleaned,
    conciseQuestion,
    subIssues,
    keywords,
    likelyLaws,
    questionTypes,
    primaryQuestionType: questionTypes[0] || "direct_ruling"
  };
}

/* ====== بناء استعلامات بحث أذكى ====== */
function makeOfficialDomainFilter() {
  return OFFICIAL_DOMAINS.map(d => `site:${d}`).join(" OR ");
}
function makeExplanatoryDomainFilter() {
  return EXPLANATORY_DOMAINS.map(d => `site:${d}`).join(" OR ");
}

function buildSearchQueries(analysis) {
  const cleaned = analysis.cleaned;
  const concise = analysis.conciseQuestion || cleaned;
  const keywordStr = analysis.keywords.join(" ").trim();
  const lawStr = analysis.likelyLaws.join(" ").trim();
  const topIssues = analysis.subIssues.slice(0, 3);

  const officialFilter = makeOfficialDomainFilter();
  const explanatoryFilter = makeExplanatoryDomainFilter();

  const queries = [];

  // رسمية
  queries.push({
    query: `${concise} ${lawStr} نص المادة نظام سعودي`.trim(),
    domainFilter: officialFilter,
    layer: "official"
  });

  if (keywordStr) {
    queries.push({
      query: `${keywordStr} ${lawStr} لائحة تنفيذية قرار تعميم`.trim(),
      domainFilter: officialFilter,
      layer: "official"
    });
  }

  for (const issue of topIssues.slice(0, 2)) {
    queries.push({
      query: `${issue} ${lawStr} السعودية`.trim(),
      domainFilter: officialFilter,
      layer: "official"
    });
  }

  // شارحة
  queries.push({
    query: `${concise} ${lawStr} شرح قانوني تحليل`.trim(),
    domainFilter: explanatoryFilter,
    layer: "explanatory"
  });

  if (topIssues[0]) {
    queries.push({
      query: `${topIssues[0]} ${lawStr} مقال قانوني سعودي`.trim(),
      domainFilter: "",
      layer: "explanatory_open"
    });
  }

  // مهنية
  if (topIssues[0]) {
    queries.push({
      query: `${topIssues[0]} محامي سعودي`.trim(),
      domainFilter: "site:linkedin.com OR site:x.com OR site:twitter.com",
      layer: "professional"
    });
  } else {
    queries.push({
      query: `${concise} محامي سعودي`.trim(),
      domainFilter: "site:linkedin.com OR site:x.com OR site:twitter.com",
      layer: "professional"
    });
  }

  return dedupeTextArray(
    queries
      .filter(q => q.query && q.query.trim())
      .map(q => JSON.stringify(q))
  ).map(s => JSON.parse(s)).slice(0, 8);
}

/* ====== تنفيذ بحث عبر Serper ====== */
async function serperSearch(query, domainFilter) {
  const finalQuery = domainFilter ? `${query} (${domainFilter})` : query;

  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      q: finalQuery,
      num: MAX_RESULTS_PER_SEARCH,
      gl: "sa",
      hl: "ar"
    })
  });

  const raw = await resp.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`فشل قراءة استجابة Serper: ${raw}`);
  }

  if (!resp.ok) throw new Error(data?.message || "خطأ في Serper");
  if (!Array.isArray(data.organic)) return [];

  return data.organic
    .map(r => ({
      title: r.title || "مصدر",
      url: r.link || "",
      snippet: r.snippet || "",
      date: r.date || ""
    }))
    .filter(r => r.url);
}

/* ====== تصنيف المصدر ====== */
function classifySource(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return { layer: 2, label: "شارح", labelEn: "explanatory" };
  }

  for (const d of OFFICIAL_DOMAINS) {
    if (hostname.includes(d)) return { layer: 1, label: "رسمي", labelEn: "official" };
  }
  for (const d of PROFESSIONAL_DOMAINS) {
    if (hostname.includes(d)) return { layer: 3, label: "مهني", labelEn: "professional" };
  }
  return { layer: 2, label: "شارح", labelEn: "explanatory" };
}

/* ====== استخراج النص من صفحة أو PDF ====== */
async function extractText(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);

    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal
    });

    clearTimeout(timeout);

    const buf = await resp.arrayBuffer();
    const contentType = resp.headers.get("content-type") || "";

    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      const parsed = await pdf(Buffer.from(buf));
      return (parsed.text || "").replace(/\s+/g, " ").slice(0, MAX_RAW_CHARS_PER_SOURCE);
    }

    const html = Buffer.from(buf).toString("utf8");
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, noscript, iframe, aside, .ads, .sidebar").remove();

    let text = "";
    for (const sel of ["article", "main", ".content", ".post-content", ".entry-content", "#content"]) {
      const found = $(sel).text();
      if (found && found.trim().length > 200) {
        text = found;
        break;
      }
    }
    if (!text) text = $("body").text();

    return (text || "").replace(/\s+/g, " ").slice(0, MAX_RAW_CHARS_PER_SOURCE);
  } catch {
    return "";
  }
}

/* ====== ترتيب النتائج ====== */
function rankResults(results, analysis) {
  const queryTerms = dedupeTextArray([
    ...analysis.keywords,
    ...analysis.subIssues.flatMap(s => s.split(/\s+/)),
    ...analysis.likelyLaws,
    ...analysis.conciseQuestion.split(/\s+/)
  ]).filter(t => t.length > 2);

  return results
    .map(r => {
      const source = classifySource(r.url);
      r.sourceType = source;
      let score = 0;

      if (source.layer === 1) score += 100;
      else if (source.layer === 2) score += 50;
      else if (source.layer === 3) score += 20;

      if (r.date) {
        try {
          const age = (Date.now() - new Date(r.date).getTime()) / (1000 * 60 * 60 * 24 * 365);
          if (age < 1) score += 30;
          else if (age < 2) score += 20;
          else if (age < 5) score += 10;
        } catch {}
      }

      const combined = `${r.title} ${r.snippet}`.toLowerCase();
      for (const term of queryTerms) {
        if (combined.includes(term.toLowerCase())) score += 4;
      }

      if (r.snippet && r.snippet.length > 80) score += 8;

      // تعزيز المصدر الرسمي إذا احتوى اسم نظام متوقع
      for (const law of analysis.likelyLaws) {
        if (`${r.title} ${r.snippet}`.includes(law)) score += 10;
      }

      r._score = score;
      return r;
    })
    .sort((a, b) => b._score - a._score);
}

/* ====== إزالة التكرار ====== */
function dedupeSources(arr) {
  const seen = new Set();
  return arr.filter(r => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

/* ====== بناء السياق ====== */
function buildContext(rankedResults) {
  return {
    official: rankedResults.filter(r => r.sourceType.layer === 1).slice(0, 6),
    explanatory: rankedResults.filter(r => r.sourceType.layer === 2).slice(0, 5),
    professional: rankedResults.filter(r => r.sourceType.layer === 3).slice(0, 4)
  };
}

/* ====== استخراج أفضل مقطع من النص ====== */
function splitTextIntoChunks(text, size = 700, overlap = 150) {
  const cleaned = (text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const chunks = [];
  let start = 0;

  while (start < cleaned.length) {
    const end = Math.min(start + size, cleaned.length);
    chunks.push(cleaned.slice(start, end));
    if (end >= cleaned.length) break;
    start += Math.max(1, size - overlap);
  }

  return chunks;
}

function scoreChunk(chunk, analysis, sourceTypeLabel) {
  let score = 0;

  const weightedTerms = dedupeTextArray([
    ...analysis.keywords,
    ...analysis.likelyLaws,
    ...analysis.subIssues.flatMap(s => s.split(/\s+/)).filter(t => t.length > 3)
  ]);

  const lower = chunk.toLowerCase();

  for (const term of weightedTerms) {
    if (lower.includes(term.toLowerCase())) score += 8;
  }

  if (/ماده\s*\d+|الماده\s*\d+/.test(chunk)) score += 12;
  if (/يعاقب|يستحق|يجوز|يلتزم|يجب|لا يجوز|يحظر|تنتهي|يفسخ|يعوض/.test(chunk)) score += 10;
  if (/لائحه|تنفيذيه|قرار|تعميم/.test(chunk)) score += 6;

  if (sourceTypeLabel === "official") score += 12;
  else if (sourceTypeLabel === "explanatory") score += 6;
  else if (sourceTypeLabel === "professional") score += 2;

  return score;
}

function selectBestExcerpt(text, analysis, sourceTypeLabel) {
  if (!text) return "";

  const chunks = splitTextIntoChunks(text, 750, 180);
  if (!chunks.length) return "";

  const scored = chunks
    .map(chunk => ({ chunk, score: scoreChunk(chunk, analysis, sourceTypeLabel) }))
    .sort((a, b) => b.score - a.score);

  return (scored[0]?.chunk || "").slice(0, MAX_EXCERPT_CHARS);
}

/* ====== استخراج نص OpenAI ====== */
function extractOpenAIText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();

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

/* ====== بناء نص المصادر المختصرة ====== */
function buildLayerText(sources, layerLabel, excerptMap, maxItems) {
  if (!sources.length) return "";

  let text = "";
  for (let i = 0; i < Math.min(sources.length, maxItems); i++) {
    const r = sources[i];
    const excerpt = excerptMap.get(r.url) || "لم يمكن استخراج مقطع كافٍ.";

    text += `
[${layerLabel} #${i + 1}]
العنوان: ${r.title}
الرابط: ${r.url}
التاريخ: ${r.date || "غير محدد"}
الملخص: ${r.snippet || "غير متاح"}
المقطع المرتبط:
${excerpt}
---------------------
`;
  }

  return text.trim();
}

/* ====== بناء البرومبت ====== */
function buildPrompt(originalQuery, analysis, contextSources, excerptMap) {
  const officialText = buildLayerText(
    contextSources.official,
    "مصدر رسمي",
    excerptMap,
    MAX_EXCERPTS_PER_LAYER.official
  );
  const explanatoryText = buildLayerText(
    contextSources.explanatory,
    "مصدر شارح",
    excerptMap,
    MAX_EXCERPTS_PER_LAYER.explanatory
  );
  const professionalText = buildLayerText(
    contextSources.professional,
    "مصدر مهني",
    excerptMap,
    MAX_EXCERPTS_PER_LAYER.professional
  );

  return `أنت مساعد قانوني سعودي داخل منصة أعراف القانونية.
اختصاصك: الاستشارات القانونية المتعلقة بالأنظمة السعودية فقط.

═══════════════════════════════════════
قواعد إلزامية
═══════════════════════════════════════
1) اعتمد على المصادر المرفقة فقط كأساس للإجابة.
2) لا تخترع نصًا نظاميًا أو مادة أو حكمًا.
3) إذا لم تجد نصًا رسميًا صريحًا:
   - اذكر ذلك بوضوح
   - ثم قدم أقرب تحليل قانوني مدعوم بالمصادر المتاحة
   - وبيّن أن هذا تحليل تفسيري وليس نصًا مباشرًا
4) لا تجعل التغريدات أو المنشورات المهنية أساس الحكم، بل للاستزادة فقط.
5) فرّق بوضوح بين:
   - النص النظامي المباشر
   - التفسير القانوني
   - التطبيق العملي
   - الرأي المهني غير الرسمي
6) يجب معالجة السؤال المعقد عبر المسائل الفرعية الواردة أدناه.
7) HTML فقط، دون أي نص خارج HTML.

═══════════════════════════════════════
تفكيك السؤال
═══════════════════════════════════════
السؤال الأصلي:
${originalQuery}

السؤال المركز:
${analysis.conciseQuestion || analysis.cleaned}

المسائل الفرعية:
${analysis.subIssues.length ? analysis.subIssues.map((s, i) => `${i + 1}. ${s}`).join("\n") : "لا توجد مسائل فرعية واضحة."}

الأنظمة المحتملة:
${analysis.likelyLaws.length ? analysis.likelyLaws.join(" | ") : "غير محدد"}

أنواع الطلب:
${analysis.questionTypes.length ? analysis.questionTypes.join(" | ") : "عام"}

═══════════════════════════════════════
منهج الإجابة
═══════════════════════════════════════
- ابدأ بالجواب المختصر جدًا.
- ثم عالج كل مسألة فرعية على حدة في التفصيل.
- ثم اذكر الأساس النظامي.
- ثم اذكر المصادر الشارحة.
- ثم الاستزادة المهنية إن وجدت.
- ثم المراجع.
- ثم مستوى الثقة وسببه.

═══════════════════════════════════════
هيكل الإخراج المطلوب
═══════════════════════════════════════
<div class="legal-answer" dir="rtl">
  <div class="section summary">
    <h2>الجواب المختصر</h2>
    <p>خلاصة دقيقة ومباشرة.</p>
  </div>

  <div class="section detail">
    <h2>التفصيل</h2>
    <ol>
      <li><strong>المسألة الأولى:</strong> ...</li>
      <li><strong>المسألة الثانية:</strong> ...</li>
    </ol>
  </div>

  <div class="section legal-basis">
    <h2>الأساس النظامي</h2>
    <ul>
      <li>اسم النظام / المادة / الجهة / التاريخ / الرابط</li>
    </ul>
  </div>

  <div class="section explanatory-sources">
    <h2>المصادر الشارحة</h2>
    <ul>
      <li>ملخص مختصر لكل مصدر شارح تم الاستفادة منه</li>
    </ul>
  </div>

  <div class="section professional-insights">
    <h2>استزادة مهنية</h2>
    <p class="disclaimer">هذه الآراء للاستزادة فقط ولا تمثل مصدرًا نظاميًا ملزمًا.</p>
    <ul>
      <li>إن وجدت مصادر مهنية، لخصها بإيجاز</li>
    </ul>
  </div>

  <div class="section sources">
    <h2>المراجع والمصادر</h2>
    <h3>المصادر الرسمية</h3>
    <ul></ul>
    <h3>المصادر الشارحة</h3>
    <ul></ul>
    <h3>المصادر المهنية</h3>
    <ul></ul>
  </div>

  <div class="section confidence">
    <h2>مستوى الثقة</h2>
    <p><strong>مرتفع / متوسط / منخفض</strong></p>
    <p>السبب المختصر.</p>
  </div>
</div>

═══════════════════════════════════════
المصادر الرسمية (${contextSources.official.length})
═══════════════════════════════════════
${officialText || "لم تُعثر على مصادر رسمية مباشرة."}

═══════════════════════════════════════
المصادر الشارحة (${contextSources.explanatory.length})
═══════════════════════════════════════
${explanatoryText || "لم تُعثر على مصادر شارحة."}

═══════════════════════════════════════
المصادر المهنية (${contextSources.professional.length})
═══════════════════════════════════════
${professionalText || "لم تُعثر على مصادر مهنية."}`;
}

/* ====== طبقة التحقق ====== */
function buildVerifierPrompt(originalQuery, generatedAnswer, analysis, contextSources) {
  const allSourceURLs = [
    ...contextSources.official.map(r => `[رسمي] ${r.title} — ${r.url}`),
    ...contextSources.explanatory.map(r => `[شارح] ${r.title} — ${r.url}`),
    ...contextSources.professional.map(r => `[مهني] ${r.title} — ${r.url}`)
  ];

  return `أنت مراجع قانوني داخل منصة أعراف القانونية.

السؤال:
${originalQuery}

المسائل الفرعية المطلوب تغطيتها:
${analysis.subIssues.length ? analysis.subIssues.map((s, i) => `${i + 1}. ${s}`).join("\n") : "لا توجد"}

الإجابة المولدة:
${generatedAnswer}

المصادر المتاحة:
${allSourceURLs.join("\n")}

مهام التحقق:
1) هل عالجت الإجابة المسائل الفرعية الأساسية؟
2) هل فرقت بين النص النظامي والتفسير والرأي المهني؟
3) هل كل ادعاء نظامي مسنود؟
4) هل ذُكرت المصادر الرسمية أولًا؟
5) إذا لا يوجد نص صريح، هل تم التنبيه لذلك بوضوح؟
6) إذا وجدت مصادر مهنية، هل ذُكرت بوصفها استزادة فقط؟
7) إذا كانت الإجابة ناقصة، فأعد كتابتها بنفس هيكل HTML فقط.

التعليمات:
- HTML فقط
- لا تخرج عن الهيكل
- لا تضف مزاعم غير مسنودة`;
}

/* ====== استدعاء OpenAI ====== */
async function callOpenAI(input, maxOutputTokens = 2600) {
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      max_output_tokens: maxOutputTokens
    })
  });

  const raw = await resp.text();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(raw || "تعذر قراءة استجابة OpenAI");
  }

  if (!resp.ok) {
    throw new Error(data?.error?.message || "خطأ في OpenAI");
  }

  return data;
}

/* ====== الخادم الرئيسي ====== */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

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
    /* 1) تحليل بنية السؤال */
    const analysis = analyzeQuestionStructure(query);

    /* 2) بناء استعلامات بحث أذكى */
    const searchQueries = buildSearchQueries(analysis);

    /* 3) تنفيذ البحث */
    const searchPromises = searchQueries.map(sq =>
      serperSearch(sq.query, sq.domainFilter)
        .then(results => {
          results.forEach(r => { r._searchLayer = sq.layer; });
          return results;
        })
        .catch(() => [])
    );

    const searchResults = await Promise.all(searchPromises);
    let allResults = dedupeSources(searchResults.flat()).slice(0, MAX_SOURCES);

    /* 4) بحث احتياطي */
    if (allResults.length < MIN_SOURCES_TARGET) {
      const fallbackQueries = [
        `${analysis.conciseQuestion} قانون سعودي`,
        `${analysis.keywords.slice(0, 5).join(" ")} السعودية`,
        `${analysis.likelyLaws.join(" ")} ${analysis.subIssues[0] || analysis.cleaned}`
      ].filter(Boolean);

      for (const fq of fallbackQueries) {
        const fallback = await serperSearch(fq, "").catch(() => []);
        allResults = dedupeSources([...allResults, ...fallback]).slice(0, MAX_SOURCES);
        if (allResults.length >= MIN_SOURCES_TARGET) break;
      }
    }

    if (!allResults.length) {
      return res.status(200).json({
        content: `<div class="legal-answer" dir="rtl"><div class="section summary"><h2>الجواب</h2><p>تعذر العثور على نتائج كافية من المصادر المتاحة. يُنصح بمراجعة <a href="https://laws.boe.gov.sa" target="_blank" rel="noopener noreferrer">هيئة الخبراء</a> أو إعادة صياغة السؤال بصيغة أكثر تحديدًا.</p></div></div>`,
        sources: [],
        type: "إجابة قانونية",
        questionType: analysis.primaryQuestionType,
        confidenceLevel: "منخفض"
      });
    }

    /* 5) ترتيب النتائج */
    const ranked = rankResults(allResults, analysis);
    const contextSources = buildContext(ranked);
    const allContextSources = [
      ...contextSources.official,
      ...contextSources.explanatory,
      ...contextSources.professional
    ];

    /* 6) استخراج النصوص */
    const extractedTexts = await Promise.all(
      allContextSources.map(async r => ({
        url: r.url,
        text: await extractText(r.url),
        label: r.sourceType?.labelEn || "explanatory"
      }))
    );

    /* 7) اختيار مقاطع مركزة بدل النصوص الطويلة */
    const excerptMap = new Map();
    for (const item of extractedTexts) {
      const excerpt = selectBestExcerpt(item.text, analysis, item.label);
      excerptMap.set(item.url, excerpt);
    }

    /* 8) بناء البرومبت */
    const prompt = buildPrompt(query, analysis, contextSources, excerptMap);

    /* 9) توليد الإجابة */
    const openaiData = await callOpenAI(prompt, 2600);
    const initialAnswer = extractOpenAIText(openaiData) || "<p>لم يتم استخراج جواب.</p>";

    /* 10) التحقق */
    const verifierPrompt = buildVerifierPrompt(query, initialAnswer, analysis, contextSources);

    let verifiedAnswer = initialAnswer;
    try {
      const verifierData = await callOpenAI(verifierPrompt, 2400);
      verifiedAnswer = extractOpenAIText(verifierData) || initialAnswer;
    } catch {}

    /* 11) مستوى الثقة */
    const officialCount = contextSources.official.length;
    const explanatoryCount = contextSources.explanatory.length;
    const totalCount = allContextSources.length;

    let confidenceLevel = "منخفض";
    if (officialCount >= 2 && totalCount >= 5) confidenceLevel = "مرتفع";
    else if (officialCount >= 1 && totalCount >= 3) confidenceLevel = "متوسط";

    if (
      analysis.subIssues.length >= 4 &&
      officialCount === 0
    ) {
      confidenceLevel = "منخفض";
    }

    return res.status(200).json({
      content: verifiedAnswer,
      sources: allContextSources.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        date: r.date,
        sourceType: r.sourceType?.label || "غير محدد"
      })),
      type: "إجابة قانونية",
      questionType: analysis.primaryQuestionType,
      questionAnalysis: {
        conciseQuestion: analysis.conciseQuestion,
        subIssues: analysis.subIssues,
        likelyLaws: analysis.likelyLaws,
        questionTypes: analysis.questionTypes
      },
      confidenceLevel,
      sourcesCount: {
        official: contextSources.official.length,
        explanatory: explanatoryCount,
        professional: contextSources.professional.length,
        total: totalCount
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "خطأ غير متوقع"
    });
  }
}
