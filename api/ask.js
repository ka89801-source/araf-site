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

  if (!query) {
    return res.status(400).json({
      error: "يرجى إدخال السؤال"
    });
  }

  const API_KEY = process.env.OPENAI_API_KEY;

  const instructions = `
أنت باحث قانوني سعودي يعمل لصالح شركة أعراف للمحاماة.

اعتمد في الإجابة على:
- الأنظمة السعودية الرسمية
- المقالات القانونية السعودية
- الشروح والمؤلفات القانونية
- الأبحاث القانونية
- تحليلات المحامين

اعتمد الأحدث فالأحدث.

يفضل إرفاق مصدر لكل فقرة متى أمكن.

اكتب الإجابة بصيغة:

عنوان الموضوع
الأساس النظامي
التحليل القانوني
الخلاصة
المراجع
`;

  try {

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: query,
        instructions: instructions,
        max_output_tokens: 2000
      })
    });

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch (err) {
      return res.status(500).json({
        error: text
      });
    }

    if (!response.ok) {
      return res.status(500).json({
        error: data.error?.message || "خطأ في OpenAI"
      });
    }

    const content =
      data.output_text ||
      "<p>تعذر الوصول إلى نتيجة واضحة.</p>";

    return res.status(200).json({
      content,
      sources: [],
      type: "إجابة قانونية"
    });

  } catch (error) {

    return res.status(500).json({
      error: error.message
    });

  }
}
