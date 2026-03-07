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
أنت باحث قانوني سعودي محترف يعمل لصالح شركة أعراف للمحاماة والاستشارات القانونية.

مهمتك إعداد دراسة قانونية قصيرة وموثقة باللغة العربية اعتمادًا على أحدث المصادر المتاحة.

### أولويات البحث:
1- المصادر الرسمية السعودية أولًا:
- هيئة الخبراء بمجلس الوزراء
- وزارة العدل
- وزارة الموارد البشرية والتنمية الاجتماعية
- التأمينات الاجتماعية
- الجهات الحكومية والتنظيمية الرسمية
- أي لوائح أو أدلة أو صفحات رسمية ذات صلة

2- المقالات القانونية السعودية المهنية:
- المقالات المنشورة في مواقع مكاتب المحاماة السعودية
- المقالات القانونية التحليلية
- المنصات القانونية السعودية
- الشروحات القانونية المهنية

3- الشروح والمؤلفات القانونية:
- الكتب القانونية
- الشروح المتخصصة للأنظمة السعودية
- المؤلفات القانونية المعروفة

4- الأبحاث والدراسات:
- الرسائل الجامعية
- الأبحاث القانونية
- الدراسات الأكاديمية

5- منشورات المحامين:
- منشورات المحامين السعوديين
- التحليلات المهنية في وسائل التواصل
- الفيديوهات القانونية التفسيرية

### قواعد العمل:
- اعتمد الأحدث فالأحدث متى كان ذلك متاحًا.
- قدم النص النظامي الرسمي دائمًا على غيره.
- يفضل أن تحتوي كل فقرة أو نقطة تحليلية على مصدر موثوق واحد على الأقل متى كان ذلك ممكنًا.
- يفضل إرفاق مصدر لكل معلومة متى كان ذلك متاحًا، مع إعطاء الأولوية للمصادر الرسمية السعودية.
- إذا تعذر الوصول إلى مصدر مباشر لكل سطر، فلا تتوقف عن الإجابة، بل قدم أفضل إجابة ممكنة مدعومة بأكبر قدر من المصادر المتاحة.
- لا تكتب معلومات عامة إنشائية بلا فائدة.
- لا تكتب مقدمة طويلة.

### تنسيق الإجابة:
اكتب الإجابة بصيغة HTML فقط بهذا الترتيب:

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

- يفضل أن تضع رابط مصدر داخل الفقرة أو النقطة متى أمكن.
- إذا لم يمكن ذلك، فاجمع المصادر في قسم المراجع في نهاية الجواب.
- لا ترجع عبارة "لم يتم العثور على إجابة واضحة" إلا إذا تعذر الوصول إلى أي أساس معقول للجواب.
`;

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        reasoning: {
          effort: "high"
        },
        instructions,
        input: query.trim(),
        tools: [
          {
            type: "web_search"
          }
        ],
        tool_choice: "auto",
        max_output_tokens: 4000
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        error: data?.error?.message || "حدث خطأ أثناء الاتصال بـ OpenAI"
      });
    }

    let content =
      data.output_text ||
      `
      <h2>تعذر إعداد الدراسة القانونية</h2>
      <p>تعذر الوصول إلى نتائج كافية لإعداد دراسة قانونية موثقة بالكامل، لكن يُفضل إعادة صياغة السؤال بشكل أكثر تحديدًا.</p>
      <h3>المراجع</h3>
      <ul></ul>
      `;

    content = content.replace(/```html/gi, "").replace(/```/g, "").trim();

    const links = [];
    const regex = /<a\\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\\/a>/gi;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const url = match[1] ? match[1].trim() : "";
      const title = match[2]
        ? match[2].replace(/<[^>]*>/g, "").trim()
        : "مصدر";

      if (url && /^https?:\\/\\//i.test(url)) {
        links.push({
          title: title || "مصدر",
          url,
          type: "مرجع",
          date: ""
        });
      }
    }

    const unique = [];
    const seen = new Set();

    for (const item of links) {
      const key = item.url;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(item);
      }
    }

    const plain = content.replace(/<[^>]*>/g, " ");
    const wc = plain.split(/\\s+/).filter(Boolean).length;

    let type = "إجابة قانونية موثقة";
    if (wc > 900) type = "دراسة قانونية موثقة";
    else if (wc > 400) type = "مقالة قانونية موثقة";

    return res.status(200).json({
      content,
      sources: unique,
      type
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message || "حدث خطأ غير متوقع"
    });
  }
}
