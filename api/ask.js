export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query } = req.body || {};

  if (!query || !query.trim()) {
    return res.status(400).json({
      error: 'يرجى إدخال استفسارك القانوني'
    });
  }

  const API_KEY = process.env.OPENAI_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({
      error: 'لم يتم تعيين OPENAI_API_KEY في إعدادات Vercel'
    });
  }

  const instructions = `
أنت باحث قانوني سعودي محترف يعمل لصالح شركة أعراف للمحاماة والاستشارات القانونية.

مهمتك إعداد دراسة قانونية قصيرة موثقة اعتمادًا على أحدث المصادر المتاحة.

### أولويات البحث:

1- المصادر الرسمية السعودية أولاً:
- هيئة الخبراء بمجلس الوزراء
- وزارة العدل
- وزارة الموارد البشرية والتنمية الاجتماعية
- التأمينات الاجتماعية
- الجهات الحكومية والتنظيمية الرسمية
- أي لوائح أو أدلة أو صفحات رسمية

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

### قواعد صارمة:

- اعتمد الأحدث فالأحدث في المعلومات.
- قدم النص النظامي الرسمي دائمًا على غيره.
- كل فقرة أو نقطة تحليلية يجب أن تحتوي على مصدر واحد على الأقل.
- إذا لم يوجد مصدر موثوق فلا تذكر المعلومة.
- لا تكتب معلومات عامة بدون مصدر.
- لا تكتب مقدمة إنشائية طويلة.

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
<li><a href="الرابط" target="_blank">اسم المصدر</a></li>
</ul>

كل فقرة أو نقطة يجب أن تحتوي على رابط مصدر.
`;

  try {

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        instructions,
        input: query,
        tools: [
          {
            type: "web_search"
          }
        ],
        tool_choice: "auto",
        max_output_tokens: 3000
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        error: data.error?.message || "خطأ في الاتصال بـ OpenAI"
      });
    }

    let content =
      data.output_text ||
      "<p>تعذر الوصول إلى مصادر كافية لإعداد إجابة موثقة.</p>";

    content = content.replace(/```html/gi, "").replace(/```/g, "");

    const links = [];
    const regex = /<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(content)) !== null) {
      links.push({
        title: match[2] || "مصدر",
        url: match[1]
      });
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

    return res.status(200).json({
      content,
      sources: unique,
      type: "إجابة قانونية موثقة"
    });

  } catch (error) {

    return res.status(500).json({
      error: error.message || "حدث خطأ غير متوقع"
    });

  }
}
