export default async function handler(req, res) {
  // CORS
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

مهمتك: إعداد دراسة قانونية قصيرة وموثقة جدًا، باللغة العربية فقط، بناءً على أحدث المصادر المتاحة.

## أولويات البحث والترجيح (بالترتيب):
1) المصادر الرسمية السعودية أولًا، مثل:
- هيئة الخبراء بمجلس الوزراء
- وزارة العدل
- وزارة الموارد البشرية والتنمية الاجتماعية
- التأمينات الاجتماعية
- الجهات الحكومية والتنظيمية الرسمية
- أي لوائح أو أدلة أو صفحات رسمية ذات صلة

2) بعد ذلك:
- الشروح والمؤلفات القانونية السعودية
- الرسائل العلمية والأبحاث والدراسات المتخصصة في الأنظمة السعودية
- المقالات القانونية المهنية المنشورة علنًا

3) بعد ذلك:
- منشورات المحامين السعوديين وشرحهم في المنصات العامة
- المحتوى المهني العام المنشور علنًا

## قواعد صارمة جدًا:
- اعتمد الأحدث فالأحدث عند التعارض أو عند وجود تحديثات.
- إذا كانت المعلومة رسمية لكنها أقدم من تعديل رسمي أحدث، فاعتمد الأحدث.
- لا تكتب أي معلومة بدون مصدر مباشر.
- كل فقرة، وكل نقطة، وكل سطر مكتوب يجب أن ينتهي برابط مصدر مباشر داخل نفس السطر.
- إذا لم تجد مصدرًا لمعلومة، فلا تذكرها أصلًا.
- قدّم المصادر الرسمية على غيرها دائمًا.
- إذا ذكرت رأيًا تفسيريًا أو شرحًا لمحامٍ أو مؤلف، فاذكر ذلك بوضوح ولا تقدمه على أنه نص نظامي.
- إذا كان السؤال يحتاج تنبيهًا بأن الإجابة تعتمد على وقائع إضافية، فاذكر هذا التنبيه مع مصدره متى أمكن.

## شكل الإجابة الإلزامي:
اكتب الجواب بصيغة HTML فقط، وبهذا الترتيب:

<h2>عنوان الموضوع</h2>

<h3>الأساس النظامي</h3>
<p>...</p>

<h3>التحليل القانوني</h3>
<p>...</p>
<ul>
  <li>...</li>
  <li>...</li>
</ul>

<h3>الخلاصة</h3>
<p>...</p>

<h3>المراجع</h3>
<ul>
  <li><a href="..." target="_blank" rel="noopener noreferrer">اسم المصدر</a></li>
</ul>

## قاعدة التوثيق داخل النص:
- بعد كل فقرة أو نقطة أو سطر ضع رابطًا مباشرًا بهذا الشكل:
<a href="الرابط" target="_blank" rel="noopener noreferrer" class="src-link">[المصدر]</a>

## ممنوع:
- ممنوع كتابة مقدمة إنشائية طويلة.
- ممنوع كتابة معلومات بلا رابط.
- ممنوع الاعتماد على معرفة عامة غير موثقة.
- ممنوع إرجاع جواب مختصر جدًا.
- ممنوع إرجاع عبارة مثل "لم يتم العثور على إجابة واضحة" إلا إذا تعذر الوصول لأي مادة صالحة، وفي هذه الحالة وضّح السبب داخل HTML.

## المطلوب من حيث الجودة:
- اجعل الجواب أقرب إلى مذكرة قانونية قصيرة.
- عند الحديث عن مزايا/سلبيات/شروط/آثار نظامية، افصلها في نقاط.
- عند وجود اختلاف بين النص النظامي والشرح المهني، قدّم النص النظامي أولًا ثم الشرح.
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
        input: query.trim(),
        tools: [
          {
            type: "web_search"
          }
        ],
        tool_choice: "auto",
        max_output_tokens: 3500
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
      `<h2>تعذر إعداد الدراسة القانونية</h2>
       <p>لم يتم الوصول إلى نتائج كافية أو موثوقة لإعداد إجابة تستوفي شرط التوثيق الكامل. <a href="#" class="src-link">[لا يوجد مصدر كافٍ]</a></p>`;

    // تنظيف بسيط
    content = content.replace(/```html/gi, "").replace(/```/g, "").trim();

    // استخراج الروابط من المحتوى نفسه
    const links = [];
    const regex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const url = match[1] ? match[1].trim() : "";
      const title = match[2]
        ? match[2].replace(/<[^>]*>/g, "").trim()
        : "مصدر";

      if (url && /^https?:\/\//i.test(url)) {
        links.push({
          title: title || "مصدر",
          url,
          type: "مرجع",
          date: ""
        });
      }
    }

    // إزالة التكرار
    const seen = new Set();
    const sources = links.filter((item) => {
      const key = `${item.title}|${item.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // تقدير نوع الناتج
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
