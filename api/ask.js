import * as cheerio from "cheerio";
import pdf from "pdf-parse";

/* ====== إعدادات ====== */
const MAX_RESULTS_PER_SEARCH = 8;
const MAX_SOURCES = 20;
const MAX_CHARS_PER_SOURCE = 5000;

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
site:twitter.com)
`;

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
  const contentType = resp.headers.get("content-type") || "";

  if (!resp.ok) {
    throw new Error(`Serper API error (${resp.status}): ${raw.slice(0, 500)}`);
  }

  if (!contentType.includes("application/json")) {
    throw new Error(
      `Serper did not return JSON. Content-Type: ${contentType}. Body: ${raw.slice(0, 500)}`
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`فشل قراءة JSON من Serper: ${raw.slice(0, 500)}`);
  }

  if (!Array.isArray(data.organic)) return [];

  return data.organic
    .map((r) => ({
      title: r.title || "مصدر",
      url: r.link || "",
      snippet: r.snippet || ""
    }))
    .filter((r) => r.url);
}

/* ====== استخراج النص من صفحة أو PDF ====== */
async function extractText(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!resp.ok) {
      return "";
    }

    const buf = await resp.arrayBuffer();
    const contentType = resp.headers.get("content-type") || "";

    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      const parsed = await pdf(Buffer.from(buf));
      return (parsed.text || "").replace(/\s+/g, " ").slice(0, MAX_CHARS_PER_SOURCE);
    }

    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return "";
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
    const systemSearch = `${query} نص النظام السعودي مادة`;
    const analysisSearch = `${query} شرح قانوني`;
    const researchSearch = `${query} دراسة قانونية`;

    const results1 = await serperSearch(systemSearch);
    const results2 = await serperSearch(analysisSearch);
    const results3 = await serperSearch(researchSearch);

    let allResults = [...results1, ...results2, ...results3];
    allResults = dedupeSources(allResults).slice(0, MAX_SOURCES);

    if (!allResults.length) {
      return res.status(200).json({
        content: "<p>تعذر العثور على نتائج كافية في المصادر القانونية المحددة.</p>",
        sources: [],
        type: "إجابة قانونية"
      });
    }

    let sourcesText = "";

    for (const r of allResults) {
      const pageText = await extractText(r.url);

      sourcesText += `
العنوان: ${r.title}
الرابط: ${r.url}
الملخص: ${r.snippet}
النص:
${pageText || "لم يمكن استخراج نص كافٍ."}

---------------------
`;
    }

    const prompt = `
السؤال:
${query}

المصادر القانونية التي تم جمعها:
${sourcesText}

أنت باحث قانوني سعودي متخصص.

التعليمات:
- اعتمد أولًا على النصوص النظامية الرسمية.
- ثم المقالات القانونية للمحامين السعوديين.
- ثم الأبحاث والدراسات.
- اعتمد الأحدث فالأحدث متى أمكن.
- اكتب الإجابة بالعربية.
- اجعل الإجابة بصيغة HTML.
- استخدم الترتيب التالي:

<h2>عنوان الموضوع</h2>

<h3>الأساس النظامي</h3>
<p>...</p>

<h3>التحليل القانوني</h3>
<ul>
<li>...</li>
</ul>

<h3>الخلاصة</h3>
<p>...</p>

<h3>المراجع</h3>
<ul>
<li><a href="..." target="_blank" rel="noopener noreferrer">اسم المصدر</a></li>
</ul>

- يفضل وضع مصدر بعد كل فقرة إن أمكن.
`;

    const openaiResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        input: prompt,
        max_output_tokens: 2500
      })
    });

    const raw = await openaiResp.text();
    const contentType = openaiResp.headers.get("content-type") || "";

    if (!openaiResp.ok) {
      return res.status(500).json({
        error: `OpenAI API error (${openaiResp.status}): ${raw.slice(0, 1000)}`
      });
    }

    if (!contentType.includes("application/json")) {
      return res.status(500).json({
        error: `OpenAI did not return JSON. Content-Type: ${contentType}. Body: ${raw.slice(0, 1000)}`
      });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(500).json({
        error: `فشل قراءة JSON من OpenAI: ${raw.slice(0, 1000)}`
      });
    }

    const content = extractOpenAIText(data) || "<p>لم يتم استخراج جواب.</p>";

    return res.status(200).json({
      content,
      sources: allResults,
      type: "إجابة قانونية"
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "خطأ غير متوقع"
    });
  }
}
