import cheerio from "cheerio";
import pdf from "pdf-parse";

async function searchSerper(query) {
  const domainFilter = `
  site:boe.gov.sa OR
  site:laws.boe.gov.sa OR
  site:moj.gov.sa OR
  site:hrsd.gov.sa OR
  site:gosi.gov.sa OR
  site:*.edu.sa
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

  const data = await response.json();

  if (!data.organic) return [];

  return data.organic.map(r => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet || ""
  }));
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

    if (contentType.includes("pdf")) {
      const parsed = await pdf(Buffer.from(buffer));
      return parsed.text.slice(0, 6000);
    }

    const html = Buffer.from(buffer).toString("utf8");
    const $ = cheerio.load(html);

    $("script, style, nav, footer, header").remove();

    const text = $("body").text();

    return text.replace(/\s+/g, " ").slice(0, 6000);

  } catch (e) {
    return "";
  }
}

export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { query } = req.body || {};

  if (!query) {
    return res.status(400).json({
      error: "يرجى إدخال السؤال"
    });
  }

  try {

    const searchResults = await searchSerper(query);

    let sourcesText = "";

    for (const r of searchResults) {
      const pageText = await extractText(r.url);

      sourcesText += `
المصدر: ${r.title}
الرابط: ${r.url}
النص:
${pageText}

-----------------------
`;
    }

    const prompt = `
السؤال:
${query}

المصادر:
${sourcesText}

اكتب دراسة قانونية قصيرة باللغة العربية اعتمادًا على المصادر أعلاه.

التعليمات:
- قدم النصوص النظامية أولًا.
- اعتمد الأحدث فالأحدث.
- بعد كل فقرة ضع مصدرها كرابط.
- استخدم صيغة HTML.
`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        input: prompt,
        max_output_tokens: 2000
      })
    });

    const data = await response.json();

    const content = data.output_text || "لم يتم العثور على نتيجة.";

    return res.status(200).json({
      content,
      sources: searchResults
    });

  } catch (error) {

    return res.status(500).json({
      error: error.message
    });

  }
}
