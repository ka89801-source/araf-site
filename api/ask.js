import * as cheerio from "cheerio";
import pdf from "pdf-parse";

/* ====== إعدادات ====== */
const MAX_RESULTS_PER_SEARCH = 8;
const MAX_SOURCES = 25;
const MAX_CHARS_PER_SOURCE = 5000;

/* ====== فلترة المصادر القانونية السعودية – الطبقة الرسمية ====== */
const OFFICIAL_DOMAIN_FILTER = `
(site:boe.gov.sa OR
site:laws.boe.gov.sa OR
site:moj.gov.sa OR
site:hrsd.gov.sa OR
site:mc.gov.sa OR
site:gosi.gov.sa OR
site:edu.sa)
`;

/* ====== فلترة تويتر (X) للمحتوى القانوني السعودي ====== */
const TWITTER_DOMAIN_FILTER = `(site:x.com OR site:twitter.com)`;

/* ====== فلترة لينكدإن للمحتوى القانوني المهني ====== */
const LINKEDIN_DOMAIN_FILTER = `(site:linkedin.com)`;

/* ====== تصنيف المصادر حسب الأولوية ====== */
function classifySource(url) {
  const u = (url || "").toLowerCase();

  if (
    u.includes("boe.gov.sa") ||
    u.includes("laws.boe.gov.sa") ||
    u.includes("moj.gov.sa") ||
    u.includes("hrsd.gov.sa") ||
    u.includes("mc.gov.sa") ||
    u.includes("gosi.gov.sa")
  ) {
    return { tier: 1, label: "مصدر رسمي حكومي" };
  }

  if (u.includes("x.com") || u.includes("twitter.com")) {
    return { tier: 2, label: "تعليق مهني – تويتر (X)" };
  }
  if (u.includes("linkedin.com")) {
    return { tier: 2, label: "تعليق مهني – لينكدإن" };
  }

  if (u.includes(".edu.sa") || u.includes(".edu/")) {
    return { tier: 3, label: "مصدر أكاديمي" };
  }

  return { tier: 4, label: "مصدر داعم" };
}

/* ====== تنفيذ بحث عبر Serper ====== */
async function serperSearch(query, domainFilter) {
  const finalQuery = `${query} ${domainFilter}`;

  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: finalQuery,
      num: MAX_RESULTS_PER_SEARCH,
    }),
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
    }))
    .filter((r) => r.url);
}

/* ====== استخراج النص من صفحة أو PDF ====== */
async function extractText(url) {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const buf = await resp.arrayBuffer();
    const contentType = resp.headers.get("content-type") || "";

    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      const parsed = await pdf(Buffer.from(buf));
      return (parsed.text || "").replace(/\s+/g, " ").slice(0, MAX_CHARS_PER_SOURCE);
    }

    const html = Buffer.from(buf).toString("utf8");
    const $ = cheerio.load(html);

    $("script, style, nav, footer, header, noscript, iframe").remove();
    const text = $("body").text();

    return (text || "").replace(/\s+/g, " ").slice(0, MAX_CHARS_PER_SOURCE);
  } catch {
    return "";
  }
}

/* ====== استخراج نص رد OpenAI (Responses API) ====== */
function extractOpenAIText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (
            (part.type === "output_text" || part.type === "text") &&
            part.text
          ) {
            parts.push(part.text);
          }
        }
      }
    }
  }

  return parts.join("\n").trim();
}

/* ====== إزالة تكرار المصادر ====== */
function dedupeSources(arr) {
  const seen = new Set();
  const out = [];

  for (const r of arr) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }

  return out;
}

/* ====== بناء نص المصادر المصنّفة للبرومبت ====== */
function buildSourcesText(allResults) {
  const sorted = [...allResults].sort((a, b) => {
    const tierA = classifySource(a.url).tier;
    const tierB = classifySource(b.url).tier;
    return tierA - tierB;
  });

  let text = "";
  for (const r of sorted) {
    const cls = classifySource(r.url);
    text += `
[${cls.label} – المستوى ${cls.tier}]
العنوان: ${r.title}
الرابط: ${r.url}
الملخص: ${r.snippet}
النص:
${r.extractedText || "لم يمكن استخراج نص كافٍ."}

---------------------
`;
  }
  return text;
}

/* ====== بناء البرومبت الرئيسي مع التحليل المتقاطع ====== */
function buildAnalysisPrompt(query, sourcesText) {
  return `
السؤال الأصلي من المستخدم:
${query}

المصادر القانونية المجمّعة (مرتبة حسب الأولوية):
${sourcesText}

أنت محلل قانوني سعودي متخصص ذو خبرة عالية في الأنظمة السعودية.

═══════════════════════════════════════
المرحلة الأولى: فحص السؤال وتصحيح التأطير القانوني
═══════════════════════════════════════
قبل الإجابة، افحص السؤال بدقة:
1. هل يحتوي السؤال على مفهوم خاطئ أو تأطير قانوني غير صحيح؟
2. هل يخلط بين أنظمة مختلفة أو يفترض حكمًا غير موجود؟
3. هل يستخدم مصطلحات قانونية بشكل غير دقيق؟

إذا وجدت خطأ في التأطير القانوني:
- اشرح الخطأ بوضوح تحت عنوان <h3>تصحيح مهم</h3>
- صحح الإطار القانوني
- أعد صياغة السؤال بشكله الصحيح
- ثم أجب على السؤال المصحح

إذا لم يكن هناك خطأ، تجاوز هذه المرحلة وأجب مباشرة.

═══════════════════════════════════════
المرحلة الثانية: التحليل المتقاطع للمصادر
═══════════════════════════════════════
1. قارن بين جميع المصادر المتاحة.
2. إذا وجدت تعارضًا بين المصادر:
   - وضّح التعارض تحت عنوان <h3>ملاحظة حول تعارض المصادر</h3>
   - بيّن أي المصادر أكثر موثوقية ولماذا.
   - المصادر الرسمية الحكومية تتقدم دائمًا على غيرها.
3. إذا تعارض تعليق مهني (تويتر/لينكدإن) مع نص نظامي رسمي، فالنص الرسمي هو المرجع.

═══════════════════════════════════════
المرحلة الثالثة: تسلسل أولوية المصادر
═══════════════════════════════════════
اعتمد على المصادر بالترتيب التالي:
1. النصوص النظامية الرسمية والمصادر الحكومية (المستوى 1)
2. التعليقات المهنية من محامين ومستشارين سعوديين على تويتر ولينكدإن (المستوى 2)
3. المقالات والأبحاث القانونية الأكاديمية (المستوى 3)
4. المصادر الداعمة الأخرى (المستوى 4)

═══════════════════════════════════════
المرحلة الرابعة: كتابة الإجابة
═══════════════════════════════════════
- اكتب الإجابة بالعربية بصيغة HTML.
- اعتمد الأحدث فالأحدث عند التعارض الزمني.
- ضع مصدرًا بعد كل فقرة إن أمكن.

استخدم الهيكل التالي:

<h2>عنوان الموضوع</h2>

<!-- إذا وُجد خطأ في التأطير القانوني -->
<h3>تصحيح مهم</h3>
<p>...</p>

<h3>الأساس النظامي</h3>
<p>...</p>

<h3>التحليل القانوني</h3>
<ul>
<li>...</li>
</ul>

<!-- إذا وُجد تعارض بين المصادر -->
<h3>ملاحظة حول تعارض المصادر</h3>
<p>...</p>

<!-- إذا وُجدت آراء مهنية مفيدة من تويتر أو لينكدإن -->
<h3>آراء المختصين</h3>
<p>...</p>

<h3>الخلاصة</h3>
<p>...</p>

<h3>المراجع</h3>
<ul>
<li><a href="..." target="_blank" rel="noopener noreferrer">اسم المصدر</a> – [نوع المصدر]</li>
</ul>

تعليمات إضافية:
- لا تختلق معلومات غير موجودة في المصادر.
- إذا لم تجد إجابة كافية في المصادر، صرّح بذلك بوضوح.
- عند ذكر مادة نظامية، حدد رقم المادة واسم النظام بدقة من المصدر.
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
    /* ─── طبقة 1: البحث في المصادر الرسمية ─── */
    const officialSearch1 = `${query} نص النظام السعودي مادة`;
    const officialSearch2 = `${query} شرح قانوني`;
    const officialSearch3 = `${query} دراسة قانونية`;

    /* ─── طبقة 2: البحث في تويتر (X) ─── */
    const twitterSearch = `${query} محامي سعودي نظام عمل قانون`;

    /* ─── طبقة 3: البحث في لينكدإن ─── */
    const linkedinSearch = `${query} محامي مستشار قانوني موارد بشرية سعودي`;

    /* ─── تنفيذ جميع عمليات البحث بالتوازي ─── */
    const [
      officialResults1,
      officialResults2,
      officialResults3,
      twitterResults,
      linkedinResults,
    ] = await Promise.all([
      serperSearch(officialSearch1, OFFICIAL_DOMAIN_FILTER),
      serperSearch(officialSearch2, OFFICIAL_DOMAIN_FILTER),
      serperSearch(officialSearch3, OFFICIAL_DOMAIN_FILTER),
      serperSearch(twitterSearch, TWITTER_DOMAIN_FILTER),
      serperSearch(linkedinSearch, LINKEDIN_DOMAIN_FILTER),
    ]);

    /* ─── دمج وإزالة التكرار ─── */
    let allResults = [
      ...officialResults1,
      ...officialResults2,
      ...officialResults3,
      ...twitterResults,
      ...linkedinResults,
    ];
    allResults = dedupeSources(allResults).slice(0, MAX_SOURCES);

    if (!allResults.length) {
      return res.status(200).json({
        content:
          "<p>تعذر العثور على نتائج كافية في المصادر القانونية المحددة.</p>",
        sources: [],
        type: "إجابة قانونية",
      });
    }

    /* ─── استخراج النصوص بالتوازي ─── */
    const extractionPromises = allResults.map(async (r) => {
      const text = await extractText(r.url);
      return { ...r, extractedText: text };
    });
    allResults = await Promise.all(extractionPromises);

    /* ─── بناء نص المصادر المصنّفة ─── */
    const sourcesText = buildSourcesText(allResults);

    /* ─── بناء البرومبت مع التحليل المتقاطع ─── */
    const prompt = buildAnalysisPrompt(query, sourcesText);

    /* ─── استدعاء OpenAI – موديل gpt-5.2 ─── */
    const openaiResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: prompt,
        max_output_tokens: 4000,
      }),
    });

    const raw = await openaiResp.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: raw });
    }

    if (!openaiResp.ok) {
      return res.status(500).json({
        error: data?.error?.message || "خطأ في OpenAI",
      });
    }

    const content =
      extractOpenAIText(data) || "<p>لم يتم استخراج جواب.</p>";

    /* ─── إرجاع النتيجة مع تصنيف المصادر ─── */
    const classifiedSources = allResults.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      ...classifySource(r.url),
    }));

    return res.status(200).json({
      content,
      sources: classifiedSources,
      type: "إجابة قانونية",
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "خطأ غير متوقع",
    });
  }
}
