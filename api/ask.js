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
    const prompt = `السؤال من المستخدم:\n${query}\n\nالمصادر القانونية المجمّعة:\n${sourcesText}\n\nأنت باحث قانوني سعودي متخصص تعمل لشركة أعراف للمحاماة. مهمتك التحقق من صحة التوصيف القانوني للسؤال ثم الإجابة.\n\n## أولاً: كشف الأخطاء التوصيفية (إلزامي)\n\nقارن جميع المصادر وافحص السؤال:\n1. قارن مصطلحات السائل مع المصطلحات الصحيحة في النظام الحالي بعد آخر التعديلات\n2. تحقق هل المفهوم القانوني لا يزال بنفس التوصيف أم تغيّر\n3. قارن ما يقوله المختصون في تويتر ولينكد إن مع النص الرسمي\n4. ابحث عن تعديلات حديثة غيّرت المفاهيم\n\nأمثلة:\n- "استقالة" في عقد محدد المدة → الصحيح "إشعار إنهاء عقد"\n- الخلط بين المادة 85 و84 بسبب تغيّر التوصيف\n\nعند اكتشاف خطأ: ابدأ بـ <h3>⚠️ تصحيح التوصيف القانوني</h3> ووضّح الخطأ مع مصادره\nعند عدم وجود خطأ: أجب مباشرة\n\n## ثانياً: الإجابة الموثّقة\n\n- اعتمد الأنظمة الرسمية أولاً ثم تويتر ولينكد إن ثم المقالات\n- اعتمد الأحدث فالأحدث\n- عند تعارض المصادر اذكره صراحة\n\n## التوثيق الإلزامي:\n- يُمنع ذكر أي معلومة بدون رابط مصدرها بعدها مباشرة\n- حتى لو سطر أو كلمة — الرابط بعدها\n- التنسيق: <a href="الرابط" target="_blank" class="src-link">اسم المصدر</a>\n- بدون مصدر = لا تذكرها\n\n## لا مقدمة تمهيدية\n\n## تنسيق HTML:\n<h2>عنوان</h2>\n<h3>⚠️ تصحيح التوصيف القانوني</h3> (إن وُجد خطأ)\n<h3>الأساس النظامي</h3>\n<h3>آراء المختصين</h3> (تغريدات ومنشورات مع روابطها)\n<h3>التحليل القانوني</h3>\n<h3>الخلاصة</h3>\n\nالحد: 8000 كلمة. العربية فقط.\n\nفي النهاية:\n|||SOURCES|||\n[{"title":"العنوان","url":"الرابط","type":"رسمي/مقالة/تويتر/لينكد إن/فيديو","date":"التاريخ"}]`;

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
