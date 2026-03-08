import cheerio from "cheerio";
import pdf from "pdf-parse";

async function searchSerper(query) {
  const domainFilter = `
(site:boe.gov.sa OR
site:laws.boe.gov.sa OR
site:moj.gov.sa OR
site:hrsd.gov.sa OR
site:gosi.gov.sa OR
site:*.edu.sa OR
site:x.com OR
site:twitter.com OR
site:linkedin.com OR
site:youtube.com)
`;

  const finalQuery = `${query} ${domainFilter}`;

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      q: finalQuery,
      num: 8
    })
  });

  const raw = await response.text();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`فشل في قراءة استجابة Serper: ${raw}`);
  }

  if (!response.ok) {
    throw new Error(data?.message || "خطأ في Serper");
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

async function extractText(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      const parsed = await pdf(Buffer.from(buffer));
      return (parsed.text || "").replace(/\s+/g, " ").slice(0, 6000);
    }

    const html = Buffer.from(buffer).toString("utf8");
    const $ = cheerio.load(html);

    $("script, style, nav, footer, header, noscript, iframe").remove();

    const text = $("body").text();
    return (text || "").replace(/\s+/g, " ").slice(0, 6000);
  } catch {
    return "";
  }
}

function extractOpenAIText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];

  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === "output_text" && typeof part.text === "string") {
            parts.push(part.text);
          }
          if (part.type === "text" && typeof part.text === "string") {
            parts.push(part.text);
          }
        }
      }
    }
  }

  return parts.join("\n").trim();
}

function extractLinksFromHtml(content) {
  const links = [];
  const regex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  let match;

  while ((match = regex.exec(content)) !== null) {
    links.push({
      title: (match[2] || "مصدر").replace(/<[^>]*>/g, "").trim(),
      url: (match[1] || "").trim()
    });
  }

  const seen = new Set();
  return links.filter((item) => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // تشخيص سريع عند فتح /api/ask مباشرة في المتصفح
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      hasOpenAI: !!process.env.OPENAI_API_KEY,
      hasSerper: !!process.env.SERPER_API_KEY
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { query } = req.body || {};

  if (!query || !query.trim()) {
    return res.status(400).json({
      error: "يرجى إدخال السؤال"
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "OPENAI_API_KEY غير موجود في Vercel"
    });
  }

  if (!process.env.SERPER_API_KEY) {
    return res.status(500).json({
      error: "SERPER_API_KEY غير موجود في Vercel"
    });
  }

  try {
    const searchResults = await searchSerper(query);

    if (!searchResults.length) {
      return res.status(200).json({
        content: "<p>تعذر العثور على نتائج بحث كافية في المصادر المحددة.</p>",
        sources: [],
        type: "إجابة قانونية"
      });
    }

    let sourcesText = "";

    for (const r of searchResults) {
      const pageText = await extractText(r.url);

      sourcesText += `
العنوان: ${r.title}
الرابط: ${r.url}
الملخص: ${r.snippet}
النص المستخرج:
${pageText || "لم يمكن استخراج نص كافٍ من هذا المصدر."}

-----------------------
`;
    }

    const prompt = `
السؤال:
${query}

المصادر التي تم جمعها:
${sourcesText}

أنت باحث قانوني سعودي محترف يعمل لصالح شركة أعراف للمحاماة والاستشارات القانونية.

التعليمات:
- أجب بالعربية فقط.
- اعتمد أولًا على المصادر الرسمية السعودية، ثم المقالات القانونية السعودية، ثم الشروح والأبحاث، ثم منشورات المحامين.
- اعتمد الأحدث فالأحدث متى أمكن.
- قدم النص النظامي الرسمي على غيره دائمًا.
- اكتب الإجابة بصيغة HTML.
- اجعل الجواب بهذا الترتيب:
<h2>عنوان الموضوع</h2>
<h3>الأساس النظامي</h3>
<p>...</p>
<h3>التحليل القانوني</h3>
<ul><li>...</li></ul>
<h3>الخلاصة</h3>
<p>...</p>
<h3>المراجع</h3>
<ul><li><a href="..." target="_blank" rel="noopener noreferrer">اسم المصدر</a></li></ul>
- يفضل وضع مصدر بعد كل فقرة أو نقطة متى أمكن.
- إذا كانت النتائج كافية فأجب، ولا تكتفِ بعبارة "لم يتم العثور على نتيجة".
`;

    const response = await fetch("https://api.openai.com/v1/responses", {
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

    const raw = await response.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(500).json({
        error: raw || "فشل في قراءة استجابة OpenAI"
      });
    }

    if (!response.ok) {
      return res.status(500).json({
        error: data?.error?.message || "خطأ في OpenAI"
      });
    }

    let content = extractOpenAIText(data);

    if (!content) {
      content = `
        <h2>تعذر استخراج جواب من النموذج</h2>
        <p>تم العثور على نتائج بحث ومصادر، لكن لم يُستخرج نص الجواب من استجابة OpenAI بالشكل المتوقع.</p>
        <h3>المراجع</h3>
        <ul>
          ${searchResults
            .map(
              (r) =>
                `<li><a href="${r.url}" target="_blank" rel="noopener noreferrer">${r.title}</a></li>`
            )
            .join("")}
        </ul>
      `;
    }

    content = content.replace(/```html/gi, "").replace(/```/g, "").trim();

    const extractedLinks = extractLinksFromHtml(content);

    return res.status(200).json({
      content,
      sources: extractedLinks.length ? extractedLinks : searchResults,
      type: "إجابة قانونية موثقة"
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "حدث خطأ غير متوقع"
    });
  }
}
// redeploy trigger


