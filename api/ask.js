import * as cheerio from "cheerio";
import pdf from "pdf-parse";

/* ====================================================================
   منصة أعراف القانونية — Workflow Engine v3
   إصلاح: توسيع البحث + فهم المصادر الشارحة + تكثيف المصادر
   ==================================================================== */

/* ====== إعدادات عامة ====== */
const MAX_RESULTS_PER_SEARCH = 10;
const MAX_SOURCES = 30;
const MAX_CHARS_PER_SOURCE = 6000;
const MIN_SOURCES_TARGET = 8;

/* ====== طبقات المصادر ====== */

const OFFICIAL_DOMAINS = [
  "laws.boe.gov.sa", "boe.gov.sa", "moj.gov.sa", "hrsd.gov.sa",
  "mlsd.gov.sa", "mc.gov.sa", "gosi.gov.sa", "nazaha.gov.sa",
  "spa.gov.sa", "mci.gov.sa", "sjc.gov.sa"
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
function cleanQuery(raw) {
  let q = raw.trim();
  q = q.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g, "");
  q = q.replace(/[أإآ]/g, "ا");
  q = q.replace(/ى/g, "ي");
  q = q.replace(/ة(?=\s|$)/g, "ه");
  return q;
}

/* ====== تصنيف نوع السؤال ====== */
function classifyQuestion(query) {
  const q = query;
  if (/صياغ|بند|عقد|نموذج|مراجع/.test(q)) return "drafting";
  if (/ما حكم|هل يجوز|هل يحق|يستحق|يلزم|واجب|محظور|ممنوع|مادة\s*\d+/.test(q)) return "direct_ruling";
  if (/لائح|إجراء|متطلب|ترخيص|تسجيل|شرط|خطوات/.test(q)) return "regulatory";
  if (/تفسير|معنى|المقصود|شرح|يقصد|دلال/.test(q)) return "interpretation";
  if (/حالت|واقع|موقف|تطبيق|عملي|لو أن|إذا كان/.test(q)) return "practical";
  if (/مقارن|فرق بين|تعارض|أيهما|الفرق/.test(q)) return "comparison";
  if (/رأي|اجتهاد|وجهة نظر|ما رأي/.test(q)) return "opinion";
  return "direct_ruling";
}

/* ====== استخراج الكلمات المفتاحية القانونية ====== */
function extractLegalKeywords(query) {
  const keywords = [];
  const articleMatches = query.match(/ماد[ةه]\s*(\d+)/g);
  if (articleMatches) keywords.push(...articleMatches);

  const legalTerms = query.match(/(فصل تعسفي|أجر إضافي|إجازة|مكافأة نهاية الخدمة|ساعات العمل|استقالة|عقد محدد المدة|عقد غير محدد|فترة التجربة|إنذار|تعويض|حقوق العامل|صاحب العمل|نقل كفالة|بدل سكن|بدل نقل|تأمينات اجتماعية|نظام العمل|نظام الشركات|نظام المعاملات المدنية|نظام الأحوال الشخصية|نظام التجارة|نظام المرافعات|نظام التنفيذ|نظام الإفلاس)/g);
  if (legalTerms) keywords.push(...legalTerms);

  return [...new Set(keywords)];
}

/* ====== بناء 8 استعلامات بحث موسّعة ====== */
function buildSearchQueries(query, questionType) {
  const cleaned = cleanQuery(query);
  const keywords = extractLegalKeywords(cleaned);
  const keywordStr = keywords.length > 0 ? keywords.join(" ") : "";
  const queries = [];

  // ─── الطبقة الأولى: الرسمية (2 استعلام) ───
  queries.push({
    query: `${cleaned} نظام سعودي نص المادة`,
    domainFilter: OFFICIAL_DOMAINS.map(d => `site:${d}`).join(" OR "),
    layer: "official"
  });
  queries.push({
    query: `${cleaned} لائحة تنفيذية قرار تعميم ${keywordStr}`.trim(),
    domainFilter: OFFICIAL_DOMAINS.map(d => `site:${d}`).join(" OR "),
    layer: "official"
  });

  // ─── الطبقة الثانية: الشارحة (3 استعلامات) ───
  queries.push({
    query: `${cleaned} شرح قانوني تحليل مقال`,
    domainFilter: EXPLANATORY_DOMAINS.map(d => `site:${d}`).join(" OR "),
    layer: "explanatory"
  });
  queries.push({
    query: `${cleaned} شرح النظام السعودي مقالة قانونية تحليل`,
    domainFilter: "",
    layer: "explanatory_open"
  });
  queries.push({
    query: `${cleaned} بحث قانوني دراسة كتاب شارح سعودي`,
    domainFilter: "",
    layer: "explanatory_open"
  });

  // ─── الطبقة الثالثة: المهنية (3 استعلامات) ───
  queries.push({
    query: `${cleaned} محامي سعودي رأي قانوني`,
    domainFilter: "site:linkedin.com",
    layer: "professional"
  });
  queries.push({
    query: `${cleaned} محامي مختص قانوني`,
    domainFilter: "site:x.com OR site:twitter.com",
    layer: "professional"
  });
  queries.push({
    query: `${cleaned} رأي محامي تجربة قانونية حكم قضائي سعودي`,
    domainFilter: "",
    layer: "professional_open"
  });

  return queries;
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
  try { data = JSON.parse(raw); } catch {
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
  try { hostname = new URL(url).hostname.toLowerCase(); } catch {
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
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal
    });
    clearTimeout(timeout);

    const buf = await resp.arrayBuffer();
    const contentType = resp.headers.get("content-type") || "";

    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      const parsed = await pdf(Buffer.from(buf));
      return (parsed.text || "").replace(/\s+/g, " ").slice(0, MAX_CHARS_PER_SOURCE);
    }

    const html = Buffer.from(buf).toString("utf8");
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, noscript, iframe, aside, .ads, .sidebar").remove();

    let text = "";
    for (const sel of ["article", "main", ".content", ".post-content", ".entry-content", "#content"]) {
      const found = $(sel).text();
      if (found && found.trim().length > 200) { text = found; break; }
    }
    if (!text) text = $("body").text();

    return (text || "").replace(/\s+/g, " ").slice(0, MAX_CHARS_PER_SOURCE);
  } catch {
    return "";
  }
}

/* ====== ترتيب النتائج ====== */
function rankResults(results, query) {
  const queryTerms = query.split(/\s+/).filter(t => t.length > 2);

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
        if (combined.includes(term.toLowerCase())) score += 5;
      }
      if (r.snippet && r.snippet.length > 100) score += 10;

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

/* ====== بناء السياق الموسّع ====== */
function buildContext(rankedResults) {
  return {
    official: rankedResults.filter(r => r.sourceType.layer === 1).slice(0, 8),
    explanatory: rankedResults.filter(r => r.sourceType.layer === 2).slice(0, 8),
    professional: rankedResults.filter(r => r.sourceType.layer === 3).slice(0, 6)
  };
}

/* ====== استخراج نص OpenAI ====== */
function extractOpenAIText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if ((part.type === "output_text" || part.type === "text") && part.text) parts.push(part.text);
        }
      }
    }
  }
  return parts.join("\n").trim();
}

/* ====== بناء نص المصادر ====== */
function buildLayerText(sources, layerLabel, sourcesTextMap) {
  if (!sources.length) return "";
  let text = "";
  for (let i = 0; i < sources.length; i++) {
    const r = sources[i];
    text += `\n[${layerLabel} #${i + 1}]\nالعنوان: ${r.title}\nالرابط: ${r.url}\nالتاريخ: ${r.date || "غير محدد"}\nالملخص: ${r.snippet}\nالنص المستخرج:\n${sourcesTextMap.get(r.url) || "لم يمكن استخراج نص كافٍ."}\n---------------------\n`;
  }
  return text;
}

/* ====== بناء البرومبت ====== */
function buildPrompt(query, questionType, contextSources, sourcesTextMap) {
  const questionTypeLabels = {
    direct_ruling: "سؤال عن حكم نظامي مباشر",
    regulatory: "سؤال عن لائحة أو إجراء أو متطلب تنظيمي",
    interpretation: "سؤال عن تفسير مادة أو نص",
    practical: "سؤال عن تطبيق عملي على واقعة",
    comparison: "سؤال عن مقارنة أو تعارض بين نصوص",
    opinion: "سؤال عن رأي مهني أو اجتهادي",
    drafting: "سؤال عن صياغة قانونية أو مراجعة بند"
  };

  const officialText = buildLayerText(contextSources.official, "مصدر رسمي", sourcesTextMap);
  const explanatoryText = buildLayerText(contextSources.explanatory, "مصدر شارح", sourcesTextMap);
  const professionalText = buildLayerText(contextSources.professional, "مصدر مهني", sourcesTextMap);
  const totalSources = contextSources.official.length + contextSources.explanatory.length + contextSources.professional.length;

  return `أنت مساعد قانوني سعودي داخل منصة أعراف القانونية.

═══════════════════════════════════════
المنهجية الإلزامية للإجابة
═══════════════════════════════════════

مهمتك ليست مجرد نقل النص النظامي، بل فهمه وشرحه بعمق.

خطوة 1: اقرأ النص الرسمي (الطبقة الأولى) وافهم الحكم النظامي.
خطوة 2: اقرأ المقالات والكتب الشارحة (الطبقة الثانية) بعناية فائقة. افهم كيف يُفسَّر النص ويُطبَّق. استخدم هذا الفهم العميق في قسم "التفصيل".
خطوة 3: اقرأ آراء المحامين من وسائل التواصل (الطبقة الثالثة) واعرضها في "استزادة مهنية".

القاعدة الذهبية: لا تجب من ذاكرتك. أجب فقط مما تجده في المصادر أدناه.

═══════════════════════════════════════
تعليمات التوليد
═══════════════════════════════════════

1. قدّم النص الرسمي أولًا ثم اشرحه بالاستعانة بالمقالات والكتب الشارحة.
2. لا تخترع حكمًا غير موجود.
3. لا تبنِ الحكم على تغريدة أو منشور.
4. إذا لم تجد نصًا رسميًا صريحًا، اذكر ذلك بوضوح.
5. فرّق بين النص الملزم والشرح والاجتهاد.
6. استخدم الأحدث فالأحدث.
7. لا تذكر معلومة غير مدعومة.

═══════════════════════════════════════
تعليمات المصادر الشارحة (حيوي)
═══════════════════════════════════════

المصادر الشارحة هي أداتك لفهم النص النظامي وشرحه للمستخدم:
- اقرأ كل مقال بعناية واستخلص: التفسيرات، الاستثناءات، التطبيقات العملية، الأحكام القضائية.
- ادمج هذا الفهم في قسم "التفصيل".
- اذكر المقالات في "المصادر الشارحة" مع اسم الكاتب والتاريخ.

═══════════════════════════════════════
تعليمات الاستزادة المهنية (حيوي)
═══════════════════════════════════════

- لا تقل "لم تُعثر على آراء مهنية" إلا إذا كانت الطبقة الثالثة فارغة فعلًا (0 مصادر).
- أي محتوى من لينكد إن أو تويتر أو إكس ← اعرضه في "استزادة مهنية".
- اذكر: اسم صاحب الرأي، المنصة، ملخص الرأي، الرابط.
- حتى لو كان عامًا، اعرضه مع تنبيه أنه رأي غير رسمي.

═══════════════════════════════════════
تعليمات المصادر (إلزامي)
═══════════════════════════════════════

- اذكر كل مصدر استفدت منه. الحد الأدنى: 6 مصادر.
- لكل مصدر: الاسم، النوع، الجهة/الكاتب، التاريخ، الرابط.
- عدد المصادر المتاحة: ${totalSources} — استخدمها جميعًا.

═══════════════════════════════════════
سياسة الامتناع المنضبط
═══════════════════════════════════════

- نص صريح ← جزم.
- نص محتمل أو شرح ← صيغة تفسيرية.
- لا نص ← "لم يظهر في المصادر الرسمية المتاحة نص صريح يحسم هذه المسألة."

═══════════════════════════════════════
هيكل الإخراج (HTML)
═══════════════════════════════════════

<div class="legal-answer" dir="rtl">
  <div class="section summary">
    <h2>الجواب المختصر</h2>
    <p>سطر أو سطران.</p>
  </div>
  <div class="section detail">
    <h2>التفصيل</h2>
    <p>شرح عميق يدمج النص الرسمي مع فهم المقالات والكتب الشارحة. اذكر التطبيقات والاستثناءات.</p>
  </div>
  <div class="section legal-basis">
    <h2>الأساس النظامي</h2>
    <p>النصوص الرسمية + رقم المادة + اسم النظام + التاريخ.</p>
  </div>
  <div class="section explanatory-sources">
    <h2>المصادر الشارحة</h2>
    <p>ملخص لأهم ما جاء في المقالات والكتب والأبحاث مع ذكر كل مصدر.</p>
  </div>
  <div class="section professional-insights">
    <h2>استزادة مهنية</h2>
    <p class="disclaimer">هذه الآراء تمثل اجتهادات مهنية غير رسمية وتُعرض للاستزادة.</p>
    <ul>
      <li><strong>اسم المختص</strong> (المنصة - التاريخ): ملخص الرأي. <a href="...">الرابط</a></li>
    </ul>
  </div>
  <div class="section sources">
    <h2>المراجع والمصادر</h2>
    <h3>المصادر الرسمية</h3>
    <ul><li><a href="..." target="_blank" rel="noopener noreferrer">اسم النظام - المادة - الجهة - التاريخ</a></li></ul>
    <h3>المصادر الشارحة</h3>
    <ul><li><a href="..." target="_blank" rel="noopener noreferrer">المقال/الكتاب - الكاتب - التاريخ</a></li></ul>
    <h3>المصادر المهنية</h3>
    <ul><li><a href="..." target="_blank" rel="noopener noreferrer">المختص - المنصة - التاريخ</a></li></ul>
  </div>
  <div class="section confidence">
    <h2>مستوى الثقة</h2>
    <p><strong>مرتفع / متوسط / منخفض</strong></p>
    <p>السبب.</p>
  </div>
</div>

═══════════════════════════════════════
السؤال
═══════════════════════════════════════
تصنيف: ${questionTypeLabels[questionType] || "عام"}

${query}

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
function buildVerifierPrompt(originalQuery, generatedAnswer, contextSources) {
  const allSourceURLs = [
    ...contextSources.official.map(r => `[رسمي] ${r.title} — ${r.url}`),
    ...contextSources.explanatory.map(r => `[شارح] ${r.title} — ${r.url}`),
    ...contextSources.professional.map(r => `[مهني] ${r.title} — ${r.url}`)
  ];

  return `أنت مراجع قانوني في منصة أعراف القانونية.

السؤال: ${originalQuery}

الإجابة المولّدة:
${generatedAnswer}

المصادر المتاحة (${allSourceURLs.length} مصدر):
${allSourceURLs.join("\n")}

═══════════════════════════════════════
مهام التحقق الإلزامية
═══════════════════════════════════════

1. هل استُخدمت المصادر الشارحة فعلًا في شرح وتفسير النص النظامي في قسم "التفصيل"؟ إذا لا ← أضف شرحًا وتحليلًا من المصادر الشارحة.
2. هل قسم "استزادة مهنية" يحتوي على آراء؟ إذا كانت مصادر مهنية موجودة لكن القسم فارغ أو يقول "لم تُعثر" ← أضف ملخصًا لكل مصدر مهني متاح.
3. هل المصادر في قسم "المراجع" لا تقل عن 6؟ إذا أقل ← أضف كل المصادر المتاحة أعلاه.
4. هل كل ادعاء نظامي مسنود؟
5. هل يوجد خلط بين الرأي والحكم؟
6. هل الأحدث مقدّم؟

التعليمات:
- إذا سليمة ومكتملة: أعدها كما هي.
- إذا نقص: أعد الكتابة بنفس هيكل HTML.
- HTML فقط، بدون نص خارجه.`;
}

/* ====== الخادم الرئيسي ====== */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { query } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: "يرجى إدخال السؤال" });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY غير موجود" });
  if (!process.env.SERPER_API_KEY) return res.status(500).json({ error: "SERPER_API_KEY غير موجود" });

  try {
    const cleaned = cleanQuery(query);
    const questionType = classifyQuestion(cleaned);
    const searchQueries = buildSearchQueries(query, questionType);

    /* ── تنفيذ 8 عمليات بحث بالتوازي ── */
    const searchPromises = searchQueries.map(sq =>
      serperSearch(sq.query, sq.domainFilter)
        .then(results => { results.forEach(r => { r._searchLayer = sq.layer; }); return results; })
        .catch(() => [])
    );
    const searchResults = await Promise.all(searchPromises);
    let allResults = dedupeSources(searchResults.flat()).slice(0, MAX_SOURCES);

    /* ── بحث احتياطي إذا المصادر قليلة ── */
    if (allResults.length < MIN_SOURCES_TARGET) {
      const fallback = await serperSearch(`${cleaned} قانون سعودي شرح تحليل`, "").catch(() => []);
      allResults = dedupeSources([...allResults, ...fallback]).slice(0, MAX_SOURCES);
    }

    if (!allResults.length) {
      return res.status(200).json({
        content: `<div class="legal-answer" dir="rtl"><div class="section summary"><h2>الجواب</h2><p>تعذر العثور على نتائج كافية. يُنصح بمراجعة <a href="https://laws.boe.gov.sa" target="_blank">هيئة الخبراء</a></p></div></div>`,
        sources: [], type: "إجابة قانونية", questionType, confidenceLevel: "منخفض"
      });
    }

    const ranked = rankResults(allResults, cleaned);
    const contextSources = buildContext(ranked);
    const allContextSources = [...contextSources.official, ...contextSources.explanatory, ...contextSources.professional];

    /* ── استخراج النصوص بالتوازي ── */
    const extractedTexts = await Promise.all(
      allContextSources.map(r => extractText(r.url).then(text => ({ url: r.url, text })))
    );
    const sourcesTextMap = new Map(extractedTexts.map(e => [e.url, e.text]));

    const prompt = buildPrompt(query, questionType, contextSources, sourcesTextMap);

    /* ── توليد الإجابة ── */
    const openaiResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "gpt-4.1", input: prompt, max_output_tokens: 4000 })
    });

    const rawResp = await openaiResp.text();
    let data;
    try { data = JSON.parse(rawResp); } catch { return res.status(500).json({ error: rawResp }); }
    if (!openaiResp.ok) return res.status(500).json({ error: data?.error?.message || "خطأ في OpenAI" });

    const initialAnswer = extractOpenAIText(data) || "<p>لم يتم استخراج جواب.</p>";

    /* ── طبقة التحقق ── */
    const verifierPrompt = buildVerifierPrompt(query, initialAnswer, contextSources);
    const verifierResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "gpt-4.1", input: verifierPrompt, max_output_tokens: 4000 })
    });

    let verifiedAnswer = initialAnswer;
    try {
      const verifierData = JSON.parse(await verifierResp.text());
      if (verifierResp.ok) verifiedAnswer = extractOpenAIText(verifierData) || initialAnswer;
    } catch {}

    /* ── حساب مستوى الثقة ── */
    const officialCount = contextSources.official.length;
    const totalCount = allContextSources.length;
    let confidenceLevel = "منخفض";
    if (officialCount >= 2 && totalCount >= 6) confidenceLevel = "مرتفع";
    else if (officialCount >= 1 && totalCount >= 3) confidenceLevel = "متوسط";

    return res.status(200).json({
      content: verifiedAnswer,
      sources: allContextSources.map(r => ({
        title: r.title, url: r.url, snippet: r.snippet,
        date: r.date, sourceType: r.sourceType?.label || "غير محدد"
      })),
      type: "إجابة قانونية",
      questionType,
      confidenceLevel,
      sourcesCount: {
        official: contextSources.official.length,
        explanatory: contextSources.explanatory.length,
        professional: contextSources.professional.length,
        total: allContextSources.length
      }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "خطأ غير متوقع" });
  }
}
