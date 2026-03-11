import * as cheerio from "cheerio";
import pdf from "pdf-parse";

/* ====================================================================
   منصة أعراف القانونية — Workflow Engine v2
   بناءً على الوورك فلو النهائي المعتمد
   ==================================================================== */

/* ====== إعدادات عامة ====== */
const MAX_RESULTS_PER_SEARCH = 8;
const MAX_SOURCES = 20;
const MAX_CHARS_PER_SOURCE = 5000;

/* ====== طبقات المصادر ====== */

// الطبقة الأولى: المصادر السعودية الرسمية الملزمة
const OFFICIAL_DOMAINS = [
  "laws.boe.gov.sa",
  "boe.gov.sa",
  "moj.gov.sa",
  "hrsd.gov.sa",
  "mlsd.gov.sa",
  "mc.gov.sa",
  "gosi.gov.sa",
  "nazaha.gov.sa",
  "spa.gov.sa",
  "mci.gov.sa",
  "sjc.gov.sa"
];

// الطبقة الثانية: المصادر السعودية الشارحة
const EXPLANATORY_DOMAINS = [
  "edu.sa",
  "ajel.sa",
  "sabq.org",
  "al-jazirah.com",
  "alyaum.com"
];

// الطبقة الثالثة: المصادر المهنية المساندة (وسائل التواصل)
const PROFESSIONAL_DOMAINS = [
  "linkedin.com",
  "x.com",
  "twitter.com"
];

// فلتر البحث الشامل
const DOMAIN_FILTER = `(${[
  ...OFFICIAL_DOMAINS.map(d => `site:${d}`),
  ...EXPLANATORY_DOMAINS.map(d => `site:${d}`),
  ...PROFESSIONAL_DOMAINS.map(d => `site:${d}`)
].join(" OR ")})`;

/* ====== المرحلة 2: تنظيف السؤال ومعالجته لغويًا ====== */
function cleanQuery(raw) {
  let q = raw.trim();

  // إزالة التشكيل
  q = q.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g, "");

  // توحيد الهمزات
  q = q.replace(/[أإآ]/g, "ا");

  // توحيد الياء والألف المقصورة
  q = q.replace(/ى/g, "ي");

  // توحيد التاء المربوطة والهاء عند الحاجة
  q = q.replace(/ة(?=\s|$)/g, "ه");

  return q;
}

/* ====== المرحلة 3: تصنيف نوع السؤال ====== */
function classifyQuestion(query) {
  const q = query.toLowerCase();

  // سؤال عن صياغة قانونية أو مراجعة بند
  if (/صياغ|بند|عقد|نموذج|مراجع/.test(q)) return "drafting";

  // سؤال عن حكم نظامي مباشر
  if (/ما حكم|هل يجوز|هل يحق|يستحق|يلزم|واجب|محظور|ممنوع|مادة\s*\d+/.test(q)) return "direct_ruling";

  // سؤال عن لائحة أو إجراء أو متطلب تنظيمي
  if (/لائح|إجراء|متطلب|ترخيص|تسجيل|شرط|خطوات/.test(q)) return "regulatory";

  // سؤال عن تفسير مادة أو نص
  if (/تفسير|معنى|المقصود|شرح|يقصد|دلال/.test(q)) return "interpretation";

  // سؤال عن تطبيق عملي على واقعة
  if (/حالت|واقع|موقف|تطبيق|عملي|لو أن|إذا كان/.test(q)) return "practical";

  // سؤال عن مقارنة أو تعارض بين نصوص
  if (/مقارن|فرق بين|تعارض|أيهما|الفرق/.test(q)) return "comparison";

  // سؤال عن رأي مهني أو اجتهادي
  if (/رأي|اجتهاد|وجهة نظر|ما رأي/.test(q)) return "opinion";

  return "direct_ruling"; // الافتراضي
}

/* ====== المرحلة 4: بناء استعلامات البحث حسب نوع السؤال ====== */
function buildSearchQueries(query, questionType) {
  const cleaned = cleanQuery(query);

  // استخراج أرقام المواد وأسماء الأنظمة إن وجدت
  const articleMatch = cleaned.match(/مادة?\s*(\d+)/);
  const articleRef = articleMatch ? `مادة ${articleMatch[1]}` : "";

  const queries = [];

  switch (questionType) {
    case "direct_ruling":
    case "regulatory":
      // البحث يبدأ بالأنظمة واللوائح والقرارات الرسمية
      queries.push({
        query: `${cleaned} نظام لائحة مادة نص رسمي`,
        layer: "official",
        domainFilter: OFFICIAL_DOMAINS.map(d => `site:${d}`).join(" OR ")
      });
      queries.push({
        query: `${cleaned} شرح قانوني تحليل`,
        layer: "explanatory",
        domainFilter: [...OFFICIAL_DOMAINS, ...EXPLANATORY_DOMAINS].map(d => `site:${d}`).join(" OR ")
      });
      queries.push({
        query: `${cleaned} رأي محامي مختص`,
        layer: "professional",
        domainFilter: PROFESSIONAL_DOMAINS.map(d => `site:${d}`).join(" OR ")
      });
      break;

    case "interpretation":
      // النص الرسمي أولًا ثم المصادر الشارحة ثم الآراء المهنية
      queries.push({
        query: `${cleaned} نص النظام ${articleRef}`,
        layer: "official",
        domainFilter: OFFICIAL_DOMAINS.map(d => `site:${d}`).join(" OR ")
      });
      queries.push({
        query: `${cleaned} تفسير شرح تحليل قانوني`,
        layer: "explanatory",
        domainFilter: [...OFFICIAL_DOMAINS, ...EXPLANATORY_DOMAINS].map(d => `site:${d}`).join(" OR ")
      });
      queries.push({
        query: `${cleaned} رأي قانوني اجتهاد`,
        layer: "professional",
        domainFilter: PROFESSIONAL_DOMAINS.map(d => `site:${d}`).join(" OR ")
      });
      break;

    case "practical":
      // النص الرسمي ثم اللائحة أو الدليل الإجرائي ثم التفسير
      queries.push({
        query: `${cleaned} نظام لائحة تنفيذية`,
        layer: "official",
        domainFilter: OFFICIAL_DOMAINS.map(d => `site:${d}`).join(" OR ")
      });
      queries.push({
        query: `${cleaned} دليل إجرائي تطبيق عملي`,
        layer: "explanatory",
        domainFilter: [...OFFICIAL_DOMAINS, ...EXPLANATORY_DOMAINS].map(d => `site:${d}`).join(" OR ")
      });
      queries.push({
        query: `${cleaned} تجربة حالة واقعية`,
        layer: "professional",
        domainFilter: PROFESSIONAL_DOMAINS.map(d => `site:${d}`).join(" OR ")
      });
      break;

    case "comparison":
      queries.push({
        query: `${cleaned} نص النظام مقارنة`,
        layer: "official",
        domainFilter: OFFICIAL_DOMAINS.map(d => `site:${d}`).join(" OR ")
      });
      queries.push({
        query: `${cleaned} فرق تحليل مقارنة قانونية`,
        layer: "explanatory",
        domainFilter: [...OFFICIAL_DOMAINS, ...EXPLANATORY_DOMAINS].map(d => `site:${d}`).join(" OR ")
      });
      break;

    case "opinion":
      queries.push({
        query: `${cleaned} نص النظام`,
        layer: "official",
        domainFilter: OFFICIAL_DOMAINS.map(d => `site:${d}`).join(" OR ")
      });
      queries.push({
        query: `${cleaned} رأي قانوني محامي مختص`,
        layer: "professional",
        domainFilter: [...PROFESSIONAL_DOMAINS, ...EXPLANATORY_DOMAINS].map(d => `site:${d}`).join(" OR ")
      });
      break;

    case "drafting":
      queries.push({
        query: `${cleaned} نظام لائحة صياغة`,
        layer: "official",
        domainFilter: OFFICIAL_DOMAINS.map(d => `site:${d}`).join(" OR ")
      });
      queries.push({
        query: `${cleaned} نموذج صياغة قانونية`,
        layer: "explanatory",
        domainFilter: [...OFFICIAL_DOMAINS, ...EXPLANATORY_DOMAINS].map(d => `site:${d}`).join(" OR ")
      });
      break;

    default:
      queries.push({
        query: `${cleaned} نظام سعودي`,
        layer: "official",
        domainFilter: OFFICIAL_DOMAINS.map(d => `site:${d}`).join(" OR ")
      });
      queries.push({
        query: `${cleaned} شرح قانوني`,
        layer: "explanatory",
        domainFilter: DOMAIN_FILTER
      });
      break;
  }

  return queries;
}

/* ====== تنفيذ بحث عبر Serper ====== */
async function serperSearch(query, domainFilter) {
  const finalQuery = `${query} (${domainFilter})`;

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
      date: r.date || ""
    }))
    .filter((r) => r.url);
}

/* ====== تصنيف المصدر حسب الطبقة ====== */
function classifySource(url) {
  const hostname = new URL(url).hostname.toLowerCase();

  for (const d of OFFICIAL_DOMAINS) {
    if (hostname.includes(d)) return { layer: 1, label: "رسمي", labelEn: "official" };
  }
  for (const d of EXPLANATORY_DOMAINS) {
    if (hostname.includes(d)) return { layer: 2, label: "شارح", labelEn: "explanatory" };
  }
  for (const d of PROFESSIONAL_DOMAINS) {
    if (hostname.includes(d)) return { layer: 3, label: "مهني", labelEn: "professional" };
  }

  return { layer: 2, label: "شارح", labelEn: "explanatory" };
}

/* ====== استخراج النص من صفحة أو PDF ====== */
async function extractText(url) {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
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

/* ====== إعادة ترتيب النتائج حسب: الحجية + الحداثة + الصلة ====== */
function rankResults(results, query) {
  const queryTerms = query.split(/\s+/).filter(t => t.length > 2);

  return results
    .map((r) => {
      const source = classifySource(r.url);
      r.sourceType = source;

      // نقاط الحجية: الرسمي أعلى
      let score = 0;
      if (source.layer === 1) score += 100;
      else if (source.layer === 2) score += 50;
      else if (source.layer === 3) score += 20;

      // نقاط الحداثة
      if (r.date) {
        try {
          const d = new Date(r.date);
          const age = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 365);
          if (age < 1) score += 30;
          else if (age < 2) score += 20;
          else if (age < 5) score += 10;
        } catch {}
      }

      // نقاط الصلة بالسؤال
      const combined = `${r.title} ${r.snippet}`.toLowerCase();
      for (const term of queryTerms) {
        if (combined.includes(term.toLowerCase())) score += 5;
      }

      r._score = score;
      return r;
    })
    .sort((a, b) => b._score - a._score);
}

/* ====== إزالة التكرار ====== */
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

/* ====== بناء السياق للنموذج (قليل حاسم خير من كثير مشتت) ====== */
function buildContext(rankedResults) {
  // الطبقة الرسمية: أفضل 5
  const official = rankedResults.filter(r => r.sourceType.layer === 1).slice(0, 5);
  // الطبقة الشارحة: أفضل 3
  const explanatory = rankedResults.filter(r => r.sourceType.layer === 2).slice(0, 3);
  // الطبقة المهنية: أفضل 3
  const professional = rankedResults.filter(r => r.sourceType.layer === 3).slice(0, 3);

  return { official, explanatory, professional };
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

/* ====== بناء البرومبت النهائي ====== */
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

  // بناء نص المصادر مع تصنيفها
  let officialText = "";
  let explanatoryText = "";
  let professionalText = "";

  for (const r of contextSources.official) {
    officialText += `
[مصدر رسمي]
العنوان: ${r.title}
الرابط: ${r.url}
التاريخ: ${r.date || "غير محدد"}
الملخص: ${r.snippet}
النص:
${sourcesTextMap.get(r.url) || "لم يمكن استخراج نص كافٍ."}
---------------------
`;
  }

  for (const r of contextSources.explanatory) {
    explanatoryText += `
[مصدر شارح]
العنوان: ${r.title}
الرابط: ${r.url}
التاريخ: ${r.date || "غير محدد"}
الملخص: ${r.snippet}
النص:
${sourcesTextMap.get(r.url) || "لم يمكن استخراج نص كافٍ."}
---------------------
`;
  }

  for (const r of contextSources.professional) {
    professionalText += `
[مصدر مهني - وسائل التواصل]
العنوان: ${r.title}
الرابط: ${r.url}
التاريخ: ${r.date || "غير محدد"}
الملخص: ${r.snippet}
النص:
${sourcesTextMap.get(r.url) || "لم يمكن استخراج نص كافٍ."}
---------------------
`;
  }

  return `
أنت مساعد قانوني سعودي داخل منصة أعراف القانونية.

═══════════════════════════════════════
تعليمات التوليد الإلزامية
═══════════════════════════════════════

1. أجب وفق الأنظمة واللوائح والقرارات والمصادر الرسمية السعودية فقط.
2. قدّم النص الرسمي أولًا، ثم الشرح، ثم الرأي المهني.
3. لا تخترع حكمًا غير موجود في المصادر المسترجعة.
4. لا تبنِ الحكم النظامي على تغريدات أو منشورات مهنية.
5. إذا لم تجد نصًا رسميًا صريحًا، فاذكر ذلك بوضوح وامتنع عن الجزم.
6. إذا كان الموجود شرحًا أو اجتهادًا، ففرّق بينه وبين النص الملزم.
7. استخدم الأحدث من المصادر النافذة.
8. لا تذكر معلومة غير مدعومة بالمصادر المسترجعة أدناه.
9. افصل دائمًا بين: الجواب النظامي، والشرح، والاستزادة المهنية.

═══════════════════════════════════════
سياسة الامتناع المنضبط
═══════════════════════════════════════

- إذا وجدت نصًا رسميًا صريحًا: أجب بجزم.
- إذا وجدت نصًا محتملًا أو شرحًا: أجب بصيغة تفسيرية مع التنبيه.
- إذا لم تجد نصًا رسميًا: لا تقل "لا أعرف"، بل قل مثلًا:
  "لم يظهر في المصادر الرسمية المتاحة نص صريح يحسم هذه المسألة."
  أو "المتاح حاليًا هو شرح أو اجتهاد مهني وليس نصًا ملزمًا."

═══════════════════════════════════════
هيكل الإخراج المطلوب (HTML)
═══════════════════════════════════════

اكتب الإجابة بصيغة HTML وفق الهيكل التالي بالضبط:

<div class="legal-answer" dir="rtl">

  <div class="section summary">
    <h2>الجواب المختصر</h2>
    <p>سطر أو سطران يجيبان مباشرة على السؤال.</p>
  </div>

  <div class="section detail">
    <h2>التفصيل</h2>
    <p>شرح مركّز ومنظم للموضوع.</p>
  </div>

  <div class="section legal-basis">
    <h2>الأساس النظامي</h2>
    <p>النصوص الرسمية التي بُني عليها الجواب مع ذكر رقم المادة واسم النظام والتاريخ.</p>
  </div>

  <div class="section explanatory-sources">
    <h2>المصادر الشارحة</h2>
    <p>إن وجدت مقالات أو كتب أو أبحاث شارحة، اذكرها هنا.</p>
  </div>

  <div class="section professional-insights">
    <h2>استزادة مهنية</h2>
    <p class="disclaimer">هذه الآراء تمثل اجتهادات أو قراءات مهنية غير رسمية، وتُعرض للاستزادة ولا تُعد نصوصًا نظامية ملزمة.</p>
    <ul>
      <li>رأي المختص مع اسمه والمنصة والتاريخ والرابط.</li>
    </ul>
  </div>

  <div class="section sources">
    <h2>المراجع والمصادر</h2>
    <h3>المصادر الرسمية</h3>
    <ul>
      <li><a href="..." target="_blank" rel="noopener noreferrer">اسم النظام - المادة - الجهة - التاريخ</a></li>
    </ul>
    <h3>المصادر الشارحة</h3>
    <ul>
      <li><a href="..." target="_blank" rel="noopener noreferrer">اسم الكتاب/المقال - الكاتب - التاريخ</a></li>
    </ul>
    <h3>المصادر المهنية</h3>
    <ul>
      <li><a href="..." target="_blank" rel="noopener noreferrer">اسم المختص - المنصة - التاريخ</a></li>
    </ul>
  </div>

  <div class="section confidence">
    <h2>مستوى الثقة</h2>
    <p><strong>مرتفع / متوسط / منخفض</strong></p>
    <p>سبب مختصر لمستوى الثقة.</p>
  </div>

</div>

═══════════════════════════════════════
قواعد المصادر
═══════════════════════════════════════

- اذكر جميع المصادر المستخدمة مع تمييز الرسمي من الشارح من المهني.
- لكل مصدر: اذكر الاسم، النوع، الجهة، التاريخ، الرابط، رقم المادة إن وجد.
- لا تسمح للتغريدات بالتصدر على النص الرسمي.
- لا تسمح للمقال القديم أن يعلو على النص الرسمي الجديد.
- لا تنقل من مصدر غير سعودي على أنه أصل للجواب.
- إذا لم يوجد محتوى في قسم "استزادة مهنية"، اكتب: "لم تُعثر على آراء مهنية ذات صلة في المصادر المتاحة."

═══════════════════════════════════════
السؤال
═══════════════════════════════════════
تصنيف السؤال: ${questionTypeLabels[questionType] || "عام"}

${query}

═══════════════════════════════════════
المصادر الرسمية (الطبقة الأولى)
═══════════════════════════════════════
${officialText || "لم تُعثر على مصادر رسمية."}

═══════════════════════════════════════
المصادر الشارحة (الطبقة الثانية)
═══════════════════════════════════════
${explanatoryText || "لم تُعثر على مصادر شارحة."}

═══════════════════════════════════════
المصادر المهنية (الطبقة الثالثة)
═══════════════════════════════════════
${professionalText || "لم تُعثر على مصادر مهنية."}
`;
}

/* ====== طبقة التحقق بعد التوليد (Verifier Layer) ====== */
function buildVerifierPrompt(originalQuery, generatedAnswer, contextSources) {
  const allSourceURLs = [
    ...contextSources.official,
    ...contextSources.explanatory,
    ...contextSources.professional
  ].map(r => r.url);

  return `
أنت مراجع قانوني في منصة أعراف القانونية. مهمتك فحص الإجابة التالية والتأكد من جودتها.

السؤال الأصلي:
${originalQuery}

الإجابة المولّدة:
${generatedAnswer}

روابط المصادر المتاحة:
${allSourceURLs.join("\n")}

═══════════════════════════════════════
مهام التحقق
═══════════════════════════════════════

1. هل كل ادعاء نظامي في الإجابة مسنود بمصدر من المصادر المسترجعة؟
2. هل يوجد خلط بين النص الرسمي والرأي المهني؟
3. هل تم اعتماد الأحدث فالأحدث؟
4. هل تم الاعتماد على تغريدة أو منشور كأساس للحكم النظامي؟
5. هل المصادر مذكورة بوضوح ومصنفة (رسمي / شارح / مهني)؟
6. هل قسم "استزادة مهنية" منفصل عن الحكم النظامي؟
7. هل مستوى الثقة مناسب لقوة المصادر؟

═══════════════════════════════════════
التعليمات
═══════════════════════════════════════

- إذا كانت الإجابة سليمة: أعدها كما هي بدون تغيير.
- إذا وجدت مشكلة: أعد كتابة الإجابة المصححة بنفس هيكل HTML المطلوب.
- إذا كان ادعاء غير مسنود: احذفه أو حوّله لصيغة "لم يتوفر نص صريح".
- إذا كان رأي مهني مقدم كحكم: انقله لقسم "استزادة مهنية".
- أعد الإجابة النهائية بصيغة HTML فقط، بدون أي نص خارج HTML.
`;
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
    /* ── المرحلة 2: تنظيف السؤال ── */
    const cleaned = cleanQuery(query);

    /* ── المرحلة 3: تصنيف نوع السؤال ── */
    const questionType = classifyQuestion(cleaned);

    /* ── المرحلة 4: بناء استعلامات البحث حسب التصنيف ── */
    const searchQueries = buildSearchQueries(query, questionType);

    /* ── المرحلة: الاسترجاع المركب ── */
    let allResults = [];
    for (const sq of searchQueries) {
      const results = await serperSearch(sq.query, sq.domainFilter);
      // نسم كل نتيجة بالطبقة التي جاءت منها
      results.forEach(r => {
        r._searchLayer = sq.layer;
      });
      allResults.push(...results);
    }

    allResults = dedupeSources(allResults).slice(0, MAX_SOURCES);

    if (!allResults.length) {
      return res.status(200).json({
        content: `<div class="legal-answer" dir="rtl">
          <div class="section summary"><h2>الجواب</h2>
          <p>تعذر العثور على نتائج كافية في المصادر القانونية السعودية المحددة.</p>
          <p>يُنصح بمراجعة موقع هيئة الخبراء: <a href="https://laws.boe.gov.sa" target="_blank">laws.boe.gov.sa</a></p>
          </div></div>`,
        sources: [],
        type: "إجابة قانونية",
        questionType,
        confidenceLevel: "منخفض"
      });
    }

    /* ── إعادة ترتيب حسب الحجية + الحداثة + الصلة ── */
    const ranked = rankResults(allResults, cleaned);

    /* ── بناء السياق (قليل حاسم خير من كثير مشتت) ── */
    const contextSources = buildContext(ranked);
    const allContextSources = [
      ...contextSources.official,
      ...contextSources.explanatory,
      ...contextSources.professional
    ];

    /* ── استخراج النصوص من الصفحات ── */
    const sourcesTextMap = new Map();
    for (const r of allContextSources) {
      const pageText = await extractText(r.url);
      sourcesTextMap.set(r.url, pageText);
    }

    /* ── بناء البرومبت ── */
    const prompt = buildPrompt(query, questionType, contextSources, sourcesTextMap);

    /* ── المرحلة: توليد الإجابة الأولية ── */
    const openaiResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        input: prompt,
        max_output_tokens: 3500
      })
    });

    const rawResp = await openaiResp.text();
    let data;
    try { data = JSON.parse(rawResp); } catch {
      return res.status(500).json({ error: rawResp });
    }

    if (!openaiResp.ok) {
      return res.status(500).json({ error: data?.error?.message || "خطأ في OpenAI" });
    }

    const initialAnswer = extractOpenAIText(data) || "<p>لم يتم استخراج جواب.</p>";

    /* ── المرحلة 8: طبقة التحقق (Verifier Layer) ── */
    const verifierPrompt = buildVerifierPrompt(query, initialAnswer, contextSources);

    const verifierResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        input: verifierPrompt,
        max_output_tokens: 3500
      })
    });

    const verifierRaw = await verifierResp.text();
    let verifierData;
    try { verifierData = JSON.parse(verifierRaw); } catch {
      // إذا فشل التحقق، نعيد الإجابة الأولية
      return res.status(200).json({
        content: initialAnswer,
        sources: allContextSources.map(r => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          date: r.date,
          sourceType: r.sourceType?.label || "غير محدد"
        })),
        type: "إجابة قانونية",
        questionType,
        confidenceLevel: "متوسط"
      });
    }

    const verifiedAnswer = verifierResp.ok
      ? (extractOpenAIText(verifierData) || initialAnswer)
      : initialAnswer;

    /* ── الإخراج النهائي ── */
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
      questionType,
      confidenceLevel: "مرتفع"
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "خطأ غير متوقع"
    });
  }
}
