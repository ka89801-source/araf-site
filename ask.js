// api/ask.js — Vercel Serverless Function
// OpenAI Responses API + Web Search

export default async function handler(req, res) {
  // CORS
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
    return res.status(400).json({ error: 'يرجى إدخال استفسارك القانوني' });
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
1) أجب بالعربية فقط.
2) ابحث أولاً في المصادر الرسمية السعودية متى كانت ذات صلة، مثل:
   - هيئة الخبراء بمجلس الوزراء
   - وزارة العدل
   - وزارة الموارد البشرية والتنمية الاجتماعية
   - التأمينات الاجتماعية
   - الجهات الحكومية والتنظيمية الرسمية
3) إن لم تكفِ المصادر الرسمية، استخدم مصادر ويب قانونية موثوقة منشورة علنًا.
4) لا تذكر معلومة قانونية جازمة بلا سند.
5) اجعل الجواب منظمًا بصيغة HTML بسيطة باستخدام:
   <h2>, <h3>, <p>, <ul>, <li>, <strong>, <blockquote>
6) اختم الجواب بفقرة قصيرة بعنوان: "الخلاصة".
7) لا تضع روابط داخل متن الجواب. سيتم عرض المصادر منفصلة.
8) إذا كان السؤال يحتمل اختلافًا بحسب الوقائع، فاذكر ذلك بوضوح.
`;

  try {
    const apiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        instructions,
        input: query.trim(),
        tools: [
          {
            type: 'web_search'
          }
        ],
        tool_choice: 'auto',
        max_output_tokens: 2200,
        include: ['web_search_call.action.sources']
      })
    });

    const data = await apiResponse.json();

    if (!apiResponse.ok) {
      const msg =
        data?.error?.message ||
        `OpenAI API error: ${apiResponse.status}`;
      return res.status(502).json({ error: msg });
    }

    const content =
      data.output_text ||
      '<p>لم يتم الحصول على إجابة واضحة. يرجى إعادة صياغة السؤال.</p>';

    // استخراج المصادر من عناصر الإخراج
    let sources = [];

    if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (
          item.type === 'web_search_call' &&
          item.action &&
          Array.isArray(item.action.sources)
        ) {
          for (const s of item.action.sources) {
            sources.push({
              title: s.title || 'مصدر',
              url: s.url || '',
              type: 'ويب',
              date: s.published_at || ''
            });
          }
        }
      }
    }

    // إزالة التكرار
    const seen = new Set();
    sources = sources.filter((s) => {
      const key = `${s.title}|${s.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // تقدير نوع الناتج
    const plain = content.replace(/<[^>]*>/g, ' ');
    const wc = plain.split(/\s+/).filter(Boolean).length;

    let type = 'إجابة قانونية موثقة';
    if (wc > 700) type = 'دراسة قانونية موثقة';
    else if (wc > 300) type = 'مقالة قانونية موثقة';

    return res.status(200).json({
      content,
      sources,
      type
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message || 'حدث خطأ غير متوقع'
    });
  }
}
