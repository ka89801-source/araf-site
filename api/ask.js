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

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`فشل قراءة استجابة Serper: ${raw}`);
  }

  if (!resp.ok) {
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

/* ====== استخراج النص من صفحة أو PDF ====== */
async function extractText(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const buf = await resp.arrayBuffer();
    const contentType = resp.headers.get("content-type") || "";

    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      const parsed = await pdf(Buffer.from(buf));
      return (parsed.text || "").replace(/\s+/g, " ").slice(0, MAX_CHARS_PER_SOURCE);
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

/* ====== استدعاء OpenAI ====== */
async function callOpenAI({ model = "gpt-4.1", input, max_output_tokens = 2500 }) {
  const openaiResp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      input,
      max_output_tokens
    })
  });

  const raw = await openaiResp.text();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(raw || "تعذر قراءة استجابة OpenAI");
  }

  if (!openaiResp.ok) {
    throw new Error(data?.error?.message || "خطأ في OpenAI");
  }

  return data;
}

/* ====== بناء نص المصادر ====== */
function buildSourcesText(allResults, extractedTextsMap) {
  let sourcesText = "";

  for (const r of allResults) {
    const pageText = extractedTextsMap.get(r.url) || "";

    sourcesText += `
العنوان: ${r.title}
الرابط: ${r.url}
الملخص: ${r.snippet}
النص:
${pageText || "لم يمكن استخراج نص كافٍ."}

---------------------
`;
  }

  return sourcesText;
}

/* ====== برومبت فحص السؤال وتكييفه ====== */
function buildIssueSpotterPrompt(query, sourcesText) {
  return `
السؤال:
${query}

المصادر القانونية التي تم جمعها:
${sourcesText}

أنت محلل قانوني سعودي متخصص، ومهمتك هنا ليست إعطاء الجواب النهائي بعد، بل فحص السؤال نفسه والتأكد من صحة توصيفه القانوني.

المطلوب:
1) استخراج عناصر السؤال القانونية.
2) تحديد المصطلحات القانونية التي استخدمها السائل.
3) التحقق هل هذه المصطلحات منطبقة فعلًا على الوقائع المذكورة أم لا.
4) اكتشاف أي فرضية خاطئة أو توصيف غير دقيق أو خلط بين مفاهيم قانونية.
5) إعادة التكييف القانوني الصحيح للمسألة إن لزم.
6) تحديد ما الذي يمكن أن ينطبق نظامًا وما الذي لا ينبغي تطبيقه لمجرد ورود لفظه في السؤال.

قواعد إلزامية:
- لا تطبق أي حكم لمجرد أن السائل استعمل لفظًا قانونيًا في السؤال.
- العبرة بالتكييف النظامي الصحيح للواقعة لا بالتسمية التي استعملها السائل.
- إذا كان السؤال مبنيًا على فرضية غير دقيقة، فاذكر ذلك بوضوح.
- فرّق بين:
  أ) المصطلح الذي استخدمه السائل
  ب) التوصيف القانوني الصحيح
- إذا لم تكن المصادر كافية للجزم، فاذكر ذلك صراحة.
- اعتمد أولًا على النصوص الرسمية، ثم الشروح والأبحاث والمنشورات المهنية كمصادر تفسيرية مساندة.

أخرج النتيجة بصيغة JSON فقط، دون أي شرح خارج JSON، وبالشكل التالي تمامًا:

{
  "question_summary": "ملخص قصير للسؤال",
  "legal_elements": {
    "contract_type": "",
    "issue_type": "",
    "parties": "",
    "duration_or_time_factor": "",
    "key_terms_used_by_user": []
  },
  "term_validation": {
    "is_user_terminology_precise": true,
    "problematic_terms": [],
    "reasoning": ""
  },
  "premise_check": {
    "has_premise_problem": true,
    "premise_problem_explanation": ""
  },
  "correct_legal_characterization": {
    "summary": "",
    "applicable_if_any": [],
    "not_applicable_if_any": []
  },
  "guidance_for_final_answer": {
    "must_correct_user_term_first": true,
    "must_warn_about_mischaracterization": true,
    "must_distinguish_between_official_rule_and_interpretation": true
  }
}

مهم جدًا:
- أعد JSON صالحًا فقط.
- لا تضف markdown.
- لا تكتب ثلاث علامات backticks.
`;
}

/* ====== تنظيف JSON المحتمل من OpenAI ====== */
function safeParseJSON(text) {
  const cleaned = (text || "")
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();

  return JSON.parse(cleaned);
}

/* ====== برومبت الجواب النهائي ====== */
function buildFinalAnswerPrompt(query, sourcesText, issueAnalysis) {
  return `
السؤال الأصلي من المستخدم:
${query}

نتيجة الفحص القانوني الأولي للسؤال:
${JSON.stringify(issueAnalysis, null, 2)}

المصادر القانونية التي تم جمعها:
${sourcesText}

أنت باحث قانوني سعودي متخصص.

مهمتك الآن: كتابة الجواب النهائي، ولكن بناءً على الفحص الأولي أعلاه، لا بناءً على ظاهر ألفاظ المستخدم فقط.

قواعد إلزامية:
- ابدأ أولًا بفحص ما إذا كان السؤال يتضمن توصيفًا قانونيًا غير دقيق.
- إذا كان في السؤال مصطلح غير منطبق أو فرضية خاطئة، فنبه إلى ذلك بوضوح ثم صحح التوصيف قبل الجواب.
- لا تطبق أي مادة أو حكم فقط لأن لفظه ورد في السؤال.
- العبرة بالتكييف الصحيح للواقعة بحسب نوع العقد والوقائع المذكورة والشروط النظامية.
- إذا وُجد فرق بين التسمية الشائعة والوصف القانوني الصحيح، فاذكر الفرق.
- اعتمد أولًا على النصوص النظامية الرسمية.
- يمكن الاستفادة من المقالات والأبحاث والمنشورات المهنية كمصادر تفسيرية، لكن لا تجعلها مقدمة على النص النظامي عند التعارض.
- إذا كانت النتيجة ترجيحية أو تحتاج إلى مزيد من الوقائع، فاذكر ذلك بوضوح.
- اكتب بالعربية.
- اجعل الجواب بصيغة HTML فقط.
- لا تضع <html> ولا <body>.
- لا تذكر تحليلات داخلية أو JSON في الجواب النهائي.

استخدم الترتيب التالي:

<h2>عنوان الموضوع</h2>

<h3>فحص توصيف السؤال</h3>
<p>...</p>

<h3>التكييف القانوني الصحيح</h3>
<p>...</p>

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

تعليمات إضافية:
- إذا كان السؤال سليمًا من جهة التوصيف، فاذكر ذلك بإيجاز.
- إذا كان السؤال غير سليم من جهة التوصيف، فابدأ بتصحيحه ثم واصل الإجابة.
- يفضل وضع إشارة داخل الفقرات من مثل: (استنادًا إلى النص النظامي)، أو (بحسب مصدر تفسيري مساند).
- لا تُسقط الحكم على وصف غير منطبق.
`;
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

    const extractedTextsMap = new Map();

    for (const r of allResults) {
      const pageText = await extractText(r.url);
      extractedTextsMap.set(r.url, pageText);
    }

    const sourcesText = buildSourcesText(allResults, extractedTextsMap);

    /* ====== المرحلة الأولى: فحص السؤال وتوصيفه ====== */
    const issueSpotterPrompt = buildIssueSpotterPrompt(query, sourcesText);

    let issueAnalysis = null;

    try {
      const issueSpotterData = await callOpenAI({
        model: "gpt-4.1",
        input: issueSpotterPrompt,
        max_output_tokens: 1800
      });

      const issueSpotterText = extractOpenAIText(issueSpotterData);
      issueAnalysis = safeParseJSON(issueSpotterText);
    } catch {
      issueAnalysis = {
        question_summary: query,
        legal_elements: {
          contract_type: "",
          issue_type: "",
          parties: "",
          duration_or_time_factor: "",
          key_terms_used_by_user: []
        },
        term_validation: {
          is_user_terminology_precise: true,
          problematic_terms: [],
          reasoning: "تعذر إجراء فحص بنيوي كامل للسؤال في هذه المحاولة."
        },
        premise_check: {
          has_premise_problem: false,
          premise_problem_explanation: ""
        },
        correct_legal_characterization: {
          summary: "",
          applicable_if_any: [],
          not_applicable_if_any: []
        },
        guidance_for_final_answer: {
          must_correct_user_term_first: false,
          must_warn_about_mischaracterization: false,
          must_distinguish_between_official_rule_and_interpretation: true
        }
      };
    }

    /* ====== المرحلة الثانية: الجواب النهائي بناءً على الفحص ====== */
    const finalPrompt = buildFinalAnswerPrompt(query, sourcesText, issueAnalysis);

    const finalData = await callOpenAI({
      model: "gpt-4.1",
      input: finalPrompt,
      max_output_tokens: 2600
    });

    const content = extractOpenAIText(finalData) || "<p>لم يتم استخراج جواب.</p>";

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
