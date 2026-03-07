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
أنت باحث قانوني متخصص يعمل لصالح شركة أعراف للمحاماة والاستشارات القانونية.

قواعد العمل:

1) أجب باللغة العربية فقط.

2) اعتمد أولاً على المصادر الرسمية السعودية مثل:
- هيئة الخبراء بمجلس الوزراء
- وزارة العدل
- وزارة الموارد البشرية
- التأمينات الاجتماعية
- الجهات الحكومية الرسمية

3) إذا لم تكف المصادر الرسمية يمكن استخدام مقالات قانونية موثوقة.

4) لا تقدم معلومات قانونية قطعية بدون مصدر.

5) نظم الإجابة باستخدام HTML بسيط مثل:
<h2>, <h3>, <p>, <ul>, <li>, <strong>, <blockquote>

6) اختم الإجابة بعنوان:
الخلاصة
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
        instructions: instructions,
        input: query,
        tools: [
          {
            type: "web_search"
          }
        ],
        tool_choice: "auto",
        max_output_tokens: 2000
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        error: data.error?.message || "خطأ في الاتصال بـ OpenAI"
      });
    }

    const content =
      data.output_text ||
      "<p>لم يتم العثور على إجابة واضحة، يرجى إعادة صياغة السؤال.</p>";

    return res.status(200).json({
      content: content,
      sources: [],
      type: "إجابة قانونية"
    });

  } catch (error) {

    return res.status(500).json({
      error: error.message || "حدث خطأ غير متوقع"
    });

  }
}
