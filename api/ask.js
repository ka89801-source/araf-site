import * as cheerio from "cheerio";
import pdf from "pdf-parse";

/* ====== إعدادات ====== */
const MAX_RESULTS_PER_SEARCH = 5;
const MAX_SOURCES = 12;
const MAX_CHARS_PER_SOURCE = 1500;

/* ====== فلترة المصادر — رسمية ====== */
const OFFICIAL_DOMAINS = `(site:boe.gov.sa OR site:laws.boe.gov.sa OR site:moj.gov.sa OR site:hrsd.gov.sa OR site:mc.gov.sa OR site:gosi.gov.sa OR site:bog.gov.sa OR site:cma.org.sa OR site:edu.sa)`;

/* ====== فلترة المصادر — تويتر ====== */
const TWITTER_DOMAINS = `(site:x.com OR site:twitter.com)`;

/* ====== فلترة المصادر — لينكد إن ====== */
const LINKEDIN_DOMAINS = `(site:linkedin.com)`;

/* ====== تنفيذ بحث عبر Serper ====== */
async function serperSearch(query, domainFilter) {
  const finalQuery = domainFilter ? `${query} ${domainFilter}` : query;

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

/* ====== تحديد نوع المصدر تلقائياً ====== */
function detectSourceType(url) {
  const u = url.toLowerCase();
  if (u.includes("x.com") || u.includes("twitter.com")) return "تويتر";
  if (u.includes("linkedin.com")) return "لينكد إن";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "فيديو";
  if (u.includes("tiktok.com")) return "فيديو";
  if (u.includes(".gov.sa") || u.includes(".edu.sa")) return "رسمي";
  return "مقالة";
}

/* ====== استخراج النص من صفحة أو PDF ====== */
async function extractText(url) {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(10000)
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
    return ($("body").text() || "").replace(/\s+/g, " ").slice(0, MAX_CHARS_PER_SOURCE);
  } catch {
    return "";
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

/* ====== الخادم ====== */
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
    /* ====== المرحلة الأولى: البحث الشامل بالتوازي ====== */

    const [r1, r2, r3, r4, r5, r6, r7] = await Promise.all([
      // 1. الأنظمة الرسمية
      serperSearch(`${query} نص النظام السعودي مادة 2025`, OFFICIAL_DOMAINS),
      serperSearch(`${query} لائحة تنفيذية تعديل`, OFFICIAL_DOMAINS),
      // 2. تويتر — محامين ومختصين
      serperSearch(`${query} محامي نظام العمل`, TWITTER_DOMAINS),
      serperSearch(`${query} موارد بشرية تحديث 2025`, TWITTER_DOMAINS),
      // 3. لينكد إن — محامين ومختصين
      serperSearch(`${query} محامي قانوني سعودي`, LINKEDIN_DOMAINS),
      // 4. مقالات قانونية
      serperSearch(`${query} شرح قانوني تحليل`, ""),
      // 5. بحث عام
      serperSearch(`${query} دراسة قانونية سعودية`, "")
    ]);

    let allResults = [...r1, ...r2, ...r3, ...r4, ...r5, ...r6, ...r7];
    allResults = dedupeSources(allResults).slice(0, MAX_SOURCES);

    // إضافة نوع المصدر
    for (const r of allResults) {
      r.type = detectSourceType(r.url);
    }

    if (!allResults.length) {
      return res.status(200).json({
        content: "<p>تعذر العثور على نتائج كافية في المصادر القانونية.</p>",
        sources: [],
        type: "إجابة قانونية"
      });
    }

    /* ====== استخراج النصوص ====== */
    let sourcesText = "";
    for (const r of allResults) {
      const pageText = await extractText(r.url);
      sourcesText += `\n[${r.type}] العنوان: ${r.title}\nالرابط: ${r.url}\n${r.date ? `التاريخ: ${r.date}` : ""}\nالملخص: ${r.snippet}\nالنص:\n${pageText || "لم يمكن استخراج نص."}\n-----\n`;
    }

    /* ====== البرومبت الشامل ====== */
    const prompt = const prompt = `السؤال من المستخدم:\n${query}\n\nالمصادر القانونية المجمّعة:\n${sourcesText}\n\nأنت باحث قانوني سعودي متخصص تعمل لشركة أعراف للمحاماة والاستشارات القانونية.\n\n## أولاً وقبل أي شيء: فحص السؤال وتصحيح التوصيف القانوني\n\nقبل أن تبدأ بالبحث عن الإجابة، افحص السؤال نفسه:\n\n1. هل المصطلحات القانونية التي استخدمها السائل صحيحة وفق النظام الحالي بعد آخر التعديلات؟\n2. هل التوصيف القانوني للمشكلة منطقي ومنطبق فعلاً؟\n3. قارن مصطلحات السائل مع ما يقوله المختصون في تويتر ولينكد إن ومع النصوص الرسمية\n4. إذا أشار عدة مختصين في تويتر أو لينكد إن لتغيير أو تصحيح معيّن فهذا مؤشر قوي على خطأ توصيفي\n\nمثال مهم:\nإذا سأل المستخدم عن "مكافأة نهاية الخدمة في حال الاستقالة في عقد غير محدد المدة":\n- الخطأ التوصيفي: بعد تحديثات نظام العمل الجديدة لا يوجد مفهوم "استقالة" في العقود غير محددة المدة\n- التوصيف الصحيح: "إشعار إنهاء عقد" وليس "استقالة"\n- النتيجة: مكافأة نهاية الخدمة تُحسب بناءً على المادة 84 من نظام العمل وليس المادة 85\n- المادة 85 كانت تُطبق على مفهوم الاستقالة القديم الذي لم يعد موجوداً في العقود غير محددة المدة\n\nإذا وجدت خطأ توصيفي:\n- ابدأ فوراً بقسم: <h3>⚠️ تصحيح التوصيف القانوني</h3>\n- وضّح الخطأ بشكل مهني ولطيف مع ذكر المصادر\n- صحّح السؤال وأخبر السائل بالتوصيف الصحيح\n- ثم ابنِ إجابتك على السؤال بعد التصحيح\n\nإذا لم تجد خطأ:\n- ابدأ البحث والمقارنة مباشرة\n\n## ثانياً: بناء الإجابة من المصادر بترتيب واضح\n\nابنِ الإجابة بالترتيب التالي مع الاستناد على جميع المصادر:\n\n1. النظام أولاً: ابدأ بالنصوص النظامية الرسمية من هيئة الخبراء ووزارة الموارد البشرية ووزارة العدل. اذكر رقم المادة ونص المادة مع رابط المصدر بعد كل معلومة.\n\n2. تغريدات المحامين والمختصين في تويتر: ماذا يقول المحامون ومختصو الموارد البشرية في تغريداتهم عن هذا الموضوع؟ اذكر اسم المختص ونص رأيه مع رابط التغريدة.\n\n3. منشورات المختصين في لينكد إن: ماذا يقول المحامون والمختصون في منشوراتهم؟ اذكر اسم المختص ورأيه مع رابط المنشور.\n\n4. المقالات القانونية: ما التحليلات والشروحات من مواقع المحاماة؟\n\n5. المقارنة والتحليل: قارن بين جميع المصادر. إذا وُجد تعارض بين المصادر اذكره صراحة وبيّن أيها أحدث وأوثق.\n\n6. الخلاصة: ملخص واضح ومحدد للإجابة.\n\n## التوثيق الإلزامي — كل معلومة بمصدرها:\n- يُمنع منعاً باتاً ذكر أي معلومة بدون رابط مصدرها بعدها مباشرة\n- حتى لو كانت كلمة واحدة أو سطر واحد — الرابط بعدها مباشرة\n- التنسيق: <a href="الرابط" target="_blank" class="src-link">اسم المصدر</a>\n- بدون مصدر = لا تذكر المعلومة إطلاقاً\n\n## لا مقدمة تمهيدية — ادخل في الموضوع فوراً\n\n## تنسيق HTML:\n<h2>عنوان الموضوع</h2>\n<h3>⚠️ تصحيح التوصيف القانوني</h3> (فقط إذا وُجد خطأ)\n<h3>الأساس النظامي</h3>\n<h3>آراء المختصين في تويتر</h3>\n<h3>آراء المختصين في لينكد إن</h3>\n<h3>التحليل والمقارنة</h3>\n<h3>الخلاصة</h3>\n\nالحد: 8000 كلمة. العربية فقط.\n\nفي النهاية:\n|||SOURCES|||\n[{"title":"العنوان","url":"الرابط","type":"رسمي/مقالة/تويتر/لينكد إن/فيديو","date":"التاريخ"}]`;

    const openaiResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        input: prompt,
        max_output_tokens: 4000
      })
    });

    const raw = await openaiResp.text();
    let data;
    try { data = JSON.parse(raw); } catch { return res.status(500).json({ error: raw }); }
    if (!openaiResp.ok) return res.status(500).json({ error: data?.error?.message || "خطأ في OpenAI" });

    let content = extractOpenAIText(data) || "<p>لم يتم استخراج جواب.</p>";

    /* ====== استخراج المصادر ====== */
    let sources = allResults.map((r) => ({ title: r.title, url: r.url, type: r.type, date: r.date || "" }));

    const idx = content.indexOf("|||SOURCES|||");
    if (idx > -1) {
      const mainContent = content.substring(0, idx).trim();
      const rest = content.substring(idx + 13);
      const match = rest.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          const ps = JSON.parse(match[0]);
          if (Array.isArray(ps) && ps.length) sources = ps;
        } catch { /* fallback */ }
      }
      content = mainContent;
    }

    /* ====== تحديد النوع ====== */
    const plain = content.replace(/<[^>]*>/g, "");
    const wc = plain.split(/\s+/).filter((w) => w).length;
    let type = "دراسة قانونية موثقة";
    if (wc < 300) type = "إجابة قانونية موثقة";
    else if (wc < 800) type = "مقالة قانونية موثقة";

    return res.status(200).json({ content, sources, type });

  } catch (error) {
    return res.status(500).json({ error: error.message || "خطأ غير متوقع" });
  }
}
