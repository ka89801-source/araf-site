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
    return res.status(400).json({
      error: "يرجى إدخال الاستفسار القانوني"
    });
  }

  const API_KEY = process.env.OPENAI_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({
      error: "لم يتم تعيين OPENAI_API_KEY في إعدادات Vercel"
    });
  }

  const instructions = `
أنت باحث قانوني سعودي يعمل لصالح شركة أعراف للمحاماة والاستشارات القانونية.

المطلوب:
- الإجابة بالعربية فقط.
- إعداد دراسة قانونية قصيرة ومنظمة.
- البدء بالمصادر الرسمية السعودية أولًا.
- تفضيل الأحدث فالأحدث عند وجود تحديثات أو مقالات أو شروح متعددة.
- تضمين المقالات القانونية السعودية المهنية.
- تضمين الشروح والمؤلفات والأبحاث القانونية السعودية متى كانت متاحة علنًا على الويب.
- يمكن الاستفادة من منشورات المحامين السعوديين العامة بوصفها مصادر تفسيرية ثانوية، لا بديلًا عن النصوص الرسمية.

أولوية المصادر:
1) المصادر الرسمية السعودية
2) المقالات القانونية السعودية المهنية
3) الشروح والمؤلفات القانونية
4) الأبحاث والدراسات
5) منشورات المحامين والمحتوى المهني العام

قواعد مهمة:
- قدّم النص النظامي الرسمي على غيره دائمًا.
- يفضل وضع مصدر داخل كل فقرة أو نقطة متى أمكن.
- إذا تعذر ذلك، فاجمع المصادر في قسم المراجع.
- لا تتوقف عن الإجابة فقط لأن بعض السطور لا تملك مصدرًا مستقلًا.
- لا تكتب مقدمة إنشائية طويلة.
- لا تقل "لم يتم العثور على إجابة واضحة" إلا إذا تعذر الوصول إلى أساس معقول للإجابة.

اكتب الجواب بصيغة HTML فقط بهذا الترتيب:

<h2>عنوان الموضوع</h2>
<h3>الأساس النظامي</h3>
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
<li><a href="الرابط" target="_blank" rel="noopener noreferrer">اسم المصدر</a></li>
</ul>
`;

  function extractTextFromOutput(data) {
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

    if (parts.length) return parts.join("\n").trim();

    if (typeof data.output_text === "string" && data.output_text.trim()) {
      return data.output_text.trim();
    }

    return "";
  }

  function extractSourcesFromOutput(data) {
    const sources = [];

    if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (
          item.type === "web_search_call" &&
          item.action &&
          Array.isArray(item.action.sources)
        ) {
          for (const s of item.action.sources) {
            if (s?.url) {
              sources.push({
                title: s.title || "مصدر",
                url: s.url,
                date: s.published_at || s.date || "",
                type: "مرجع"
              });
            }
          }
        }
      }
    }

    const seen = new Set();
    return sources.filter((s) => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: query.trim(),
        instructions,
        tools: [
          {
            type: "web_search"
          }
        ],
        tool_choice: "auto",
        include: ["web_search_call.action.sources"],
        max_output_tokens: 3000
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
      return res.status(502).json({
        error: data?.error?.message || "حدث خطأ أثناء الاتصال بـ OpenAI"
      });
    }

    let content = extractTextFromOutput(data);
    const sources = extractSourcesFromOutput(data);

    if (!content) {
      content = `
        <h2>تعذر إعداد الدراسة القانونية</h2>
        <p>تعذر الوصول إلى نتائج كافية لإعداد إجابة موثقة بشكل مناسب.</p>
        <h3>المراجع</h3>
        <ul></ul>
      `.trim();
    } else {
      content = content.replace(/```html/gi, "").replace(/```/g, "").trim();

      if (!/<h3>\s*المراجع\s*<\/h3>/i.test(content) && sources.length) {
        const refs = sources
          .map(
            (s) =>
              `<li><a href="${s.url}" target="_blank" rel="noopener noreferrer">${s.title}</a></li>`
          )
          .join("");

        content += `\n<h3>المراجع</h3>\n<ul>${refs}</ul>`;
      }
    }

    const plain = content.replace(/<[^>]*>/g, " ");
    const wc = plain.split(/\s+/).filter(Boolean).length;

    let type = "إجابة قانونية موثقة";
    if (wc > 900) type = "دراسة قانونية موثقة";
    else if (wc > 400) type = "مقالة قانونية موثقة";

    return res.status(200).json({
      content,
      sources,
      type
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "حدث خطأ غير متوقع"
    });
  }
}
