import * as cheerio from "cheerio";
import pdf from "pdf-parse";

/* =========================
 * إعدادات عامة
 * ========================= */
const MAX_RESULTS_PER_QUERY = 8;
const MAX_TOTAL_RESULTS = 36;
const MAX_CONTEXT_ITEMS = 10;
const MAX_CONTEXT_CHARS_PER_SOURCE = 3500;
const FETCH_TIMEOUT_MS = 15000;

/* =========================
 * طبقات المصادر
 * ========================= */
const SOURCE_LAYERS = {
  official: [
    "boe.gov.sa",
    "laws.boe.gov.sa",
    "ummalqura.org.sa",
    "moj.gov.sa",
    "hrsd.gov.sa",
    "mc.gov.sa",
    "gosi.gov.sa",
    "zakat.gov.sa",
    "zatca.gov.sa",
    "sca.sa",
    "mewa.gov.sa",
    "momrah.gov.sa",
    "balady.gov.sa",
    "moi.gov.sa",
    "mci.gov.sa",
    "sdaia.gov.sa",
    "cchi.gov.sa",
    "sama.gov.sa",
    "cma.org.sa",
    "splonline.com.sa",
    "ncnp.gov.sa",
    "nwc.com.sa",
    "mwan.gov.sa",
    "edu.sa"
  ],
  explanatory: [
    "lawfirmsaudi.com",
    "saudilegal.com",
    "blogspot.com",
    "medium.com",
    "linkedin.com",
    "edu.sa"
  ],
  professional: [
    "x.com",
    "twitter.com",
    "linkedin.com"
  ]
};

const ALL_ALLOWED_DOMAINS = [
  ...SOURCE_LAYERS.official,
  ...SOURCE_LAYERS.explanatory,
  ...SOURCE_LAYERS.professional
];

const OFFICIAL_DOMAIN_FILTER = SOURCE_LAYERS.official.map((d) => `site:${d}`).join(" OR ");
const EXPLANATORY_DOMAIN_FILTER = SOURCE_LAYERS.explanatory.map((d) => `site:${d}`).join(" OR ");
const PROFESSIONAL_DOMAIN_FILTER = SOURCE_LAYERS.professional.map((d) => `site:${d}`).join(" OR ");
const ALL_DOMAIN_FILTER = ALL_ALLOWED_DOMAINS.map((d) => `site:${d}`).join(" OR ");

/* =========================
 * أنواع الأسئلة
 * ========================= */
type QuestionType =
  | "direct_rule"
  | "regulatory_requirement"
  | "interpretation"
  | "practical_application"
  | "comparison_conflict"
  | "professional_opinion"
  | "drafting_review"
  | "general_legal";

type SourceKind = "official" | "explanatory" | "professional";
type ConfidenceLevel = "مرتفع" | "متوسط" | "منخفض";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  sourceKind: SourceKind;
  domain: string;
  publishDate?: string | null;
}

interface EnrichedSource extends SearchResult {
  text: string;
  status: "نافذ أو غير محدد" | "معدل" | "ملغى" | "قديم" | "غير واضح";
  legalWeight: number;
  relevanceScore: number;
  freshnessScore: number;
  totalScore: number;
}

interface QueryAnalysis {
  original: string;
  normalized: string;
  keywords: string[];
  detectedEntities: string[];
  detectedArticles: string[];
  questionType: QuestionType;
  hasTimeContext: boolean;
}

/* =========================
 * أدوات مساعدة
 * ========================= */
function normalizeArabic(text = ""): string {
  return text
    .replace(/[ً-ْ]/g, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(text = ""): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function getDomain(url = ""): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function detectSourceKind(url = ""): SourceKind {
  const domain = getDomain(url);

  if (SOURCE_LAYERS.official.some((d) => domain.endsWith(d))) return "official";
  if (SOURCE_LAYERS.professional.some((d) => domain.endsWith(d))) return "professional";
  return "explanatory";
}

function inferDocumentStatus(text: string, title: string): EnrichedSource["status"] {
  const joined = `${title} ${text}`.toLowerCase();

  if (/ملغ[اة]|أُلغي|الغاء|منسوخ|repealed|revoked/.test(joined)) return "ملغى";
  if (/معدل|تعديل|amended|updated/.test(joined)) return "معدل";
  if (/قديم|نسخة سابقة|old version/.test(joined)) return "قديم";

  return "نافذ أو غير محدد";
}

function extractArticles(text: string): string[] {
  const matches = text.match(/(?:المادة|مادة)\s*\(?\s*\d+\s*\)?/g) || [];
  return uniq(matches.map((m) => m.trim()));
}

function extractKeywords(query: string): string[] {
  const cleaned = normalizeArabic(query)
    .replace(/[^\u0600-\u06FF0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const stopWords = new Set([
    "ما", "ماذا", "هل", "من", "الى", "على", "في", "عن", "او", "ثم", "هذا", "هذه",
    "ذلك", "تلك", "كيف", "متى", "اذا", "إن", "ان", "مع", "بين", "حكم", "بشأن",
    "حول", "بخصوص", "الذي", "التي", "و", "ل", "ب", "ال"
  ]);

  return uniq(cleaned.filter((w) => w.length > 1 && !stopWords.has(w))).slice(0, 12);
}

function detectEntities(query: string): string[] {
  const entities: string[] = [];
  const q = normalizeArabic(query);

  const known = [
    "نظام العمل",
    "نظام الشركات",
    "نظام المعاملات المدنية",
    "اللائحة التنفيذية",
    "وزارة الموارد البشرية",
    "وزارة التجارة",
    "وزارة العدل",
    "التامينات الاجتماعية",
    "المحكمة",
    "العقد",
    "ترخيص",
    "لائحة",
    "قرار",
    "تعميم"
  ];

  for (const item of known) {
    if (normalizeArabic(item) && q.includes(normalizeArabic(item))) {
      entities.push(item);
    }
  }

  return uniq(entities);
}

function classifyQuestion(query: string): QuestionType {
  const q = normalizeArabic(query);

  if (/صياغ|مراجعه بند|راجع بند|شرط تعاقدي|عقد|اتفاقيه/.test(q)) return "drafting_review";
  if (/تعارض|مقارنه|فرق|يتعارض|يتعارضان/.test(q)) return "comparison_conflict";
  if (/تفسير|شرح ماده|الماده|يفسر|مقصود/.test(q)) return "interpretation";
  if (/ترخيص|اجراء|متطلب|اشتراط|تصريح|رخصه/.test(q)) return "regulatory_requirement";
  if (/هل يجوز|هل يحق|هل يستحق|ما الحكم|حكم/.test(q)) return "direct_rule";
  if (/على واقعه|في هذه الحاله|عمليا|تطبيق/.test(q)) return "practical_application";
  if (/راي|وجهه نظر|اجتهاد/.test(q)) return "professional_opinion";

  return "general_legal";
}

function analyzeQuery(query: string): QueryAnalysis {
  return {
    original: query,
    normalized: normalizeArabic(query),
    keywords: extractKeywords(query),
    detectedEntities: detectEntities(query),
    detectedArticles: extractArticles(query),
    questionType: classifyQuestion(query),
    hasTimeContext: /اليوم|حاليا|حالي|سابق|سابقا|وقت|عام|سنه|سابقه|نافذ/.test(normalizeArabic(query))
  };
}

function buildSearchQueries(analysis: QueryAnalysis) {
  const base = analysis.original.trim();
  const officialQueries: string[] = [];
  const explanatoryQueries: string[] = [];
  const professionalQueries: string[] = [];

  const articleHint = analysis.detectedArticles.join(" ");
  const entityHint = analysis.detectedEntities.join(" ");
  const keywordHint = analysis.keywords.slice(0, 6).join(" ");

  switch (analysis.questionType) {
    case "direct_rule":
      officialQueries.push(
        `${base} (${OFFICIAL_DOMAIN_FILTER})`,
        `${keywordHint} ${articleHint} نص النظام السعودي (${OFFICIAL_DOMAIN_FILTER})`,
        `${base} لائحة تنفيذية قرار رسمي سعودي (${OFFICIAL_DOMAIN_FILTER})`
      );
      explanatoryQueries.push(
        `${base} شرح قانوني سعودي (${EXPLANATORY_DOMAIN_FILTER})`,
        `${keywordHint} شرح قانوني سعودي (${EXPLANATORY_DOMAIN_FILTER})`
      );
      professionalQueries.push(
        `${base} رأي قانوني سعودي (${PROFESSIONAL_DOMAIN_FILTER})`
      );
      break;

    case "regulatory_requirement":
      officialQueries.push(
        `${base} متطلبات ترخيص قرار لائحة (${OFFICIAL_DOMAIN_FILTER})`,
        `${keywordHint} ترخيص اشتراطات رسميه سعوديه (${OFFICIAL_DOMAIN_FILTER})`
      );
      explanatoryQueries.push(
        `${base} شرح متطلبات الترخيص سعودي (${EXPLANATORY_DOMAIN_FILTER})`
      );
      professionalQueries.push(
        `${base} مختصون قانونيون سعوديون (${PROFESSIONAL_DOMAIN_FILTER})`
      );
      break;

    case "interpretation":
      officialQueries.push(
        `${base} ${entityHint} ${articleHint} (${OFFICIAL_DOMAIN_FILTER})`,
        `${keywordHint} ماده تفسير نص رسمي سعودي (${OFFICIAL_DOMAIN_FILTER})`
      );
      explanatoryQueries.push(
        `${base} شرح المادة سعودي (${EXPLANATORY_DOMAIN_FILTER})`,
        `${keywordHint} تفسير المادة سعودي (${EXPLANATORY_DOMAIN_FILTER})`
      );
      professionalQueries.push(
        `${base} تفسير محامين سعوديين (${PROFESSIONAL_DOMAIN_FILTER})`
      );
      break;

    case "comparison_conflict":
      officialQueries.push(
        `${base} تعارض مواد نظام سعودي (${OFFICIAL_DOMAIN_FILTER})`,
        `${keywordHint} مقارنة مواد لائحة نظام سعودي (${OFFICIAL_DOMAIN_FILTER})`
      );
      explanatoryQueries.push(
        `${base} شرح التعارض القانوني السعودي (${EXPLANATORY_DOMAIN_FILTER})`
      );
      professionalQueries.push(
        `${base} رأي مهني سعودي (${PROFESSIONAL_DOMAIN_FILTER})`
      );
      break;

    case "drafting_review":
      officialQueries.push(
        `${base} نظام سعودي صحة الشرط (${OFFICIAL_DOMAIN_FILTER})`,
        `${keywordHint} شرط تعاقدي نظام سعودي (${OFFICIAL_DOMAIN_FILTER})`
      );
      explanatoryQueries.push(
        `${base} مراجعة قانونية سعودية (${EXPLANATORY_DOMAIN_FILTER})`
      );
      professionalQueries.push(
        `${base} محامون سعوديون (${PROFESSIONAL_DOMAIN_FILTER})`
      );
      break;

    default:
      officialQueries.push(
        `${base} (${OFFICIAL_DOMAIN_FILTER})`,
        `${keywordHint} نظام سعودي لائحة قرار (${OFFICIAL_DOMAIN_FILTER})`
      );
      explanatoryQueries.push(
        `${base} شرح قانوني سعودي (${EXPLANATORY_DOMAIN_FILTER})`
      );
      professionalQueries.push(
        `${base} قانونيون سعوديون (${PROFESSIONAL_DOMAIN_FILTER})`
      );
      break;
  }

  return {
    officialQueries: uniq(officialQueries),
    explanatoryQueries: uniq(explanatoryQueries),
    professionalQueries: uniq(professionalQueries)
  };
}

async function fetchWithTimeout(url: string, options: any = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

/* =========================
 * Serper Search
 * ========================= */
async function serperSearch(query: string, sourceKind: SourceKind): Promise<SearchResult[]> {
  const resp = await fetchWithTimeout("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY || "",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      q: query,
      num: MAX_RESULTS_PER_QUERY,
      gl: "sa",
      hl: "ar"
    })
  });

  const raw = await resp.text();

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`فشل قراءة استجابة Serper: ${raw}`);
  }

  if (!resp.ok) {
    throw new Error(data?.message || "خطأ في Serper");
  }

  const organic = Array.isArray(data.organic) ? data.organic : [];

  return organic
    .map((r: any) => {
      const url = r.link || "";
      return {
        title: r.title || "مصدر",
        url,
        snippet: r.snippet || "",
        sourceKind,
        domain: getDomain(url),
        publishDate: r.date || null
      } as SearchResult;
    })
    .filter((r: SearchResult) => {
      if (!r.url) return false;
      const domain = r.domain;
      return ALL_ALLOWED_DOMAINS.some((d) => domain.endsWith(d));
    });
}

/* =========================
 * استخراج النص
 * ========================= */
async function extractText(url: string): Promise<string> {
  try {
    const resp = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const buf = await resp.arrayBuffer();
    const contentType = resp.headers.get("content-type") || "";

    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      const parsed = await pdf(Buffer.from(buf));
      return (parsed.text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_CONTEXT_CHARS_PER_SOURCE);
    }

    const html = Buffer.from(buf).toString("utf8");
    const $ = cheerio.load(html);

    $("script, style, nav, footer, header, noscript, iframe, form").remove();

    const text = $("body").text() || "";

    return text
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_CONTEXT_CHARS_PER_SOURCE);
  } catch {
    return "";
  }
}

/* =========================
 * إزالة التكرار
 * ========================= */
function dedupeResults(items: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];

  for (const item of items) {
    const key = item.url.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

/* =========================
 * حساب الصلة والوزن
 * ========================= */
function scoreRelevance(queryAnalysis: QueryAnalysis, item: SearchResult, text: string): number {
  const haystack = normalizeArabic(`${item.title} ${item.snippet} ${text}`);
  let score = 0;

  for (const kw of queryAnalysis.keywords) {
    if (haystack.includes(normalizeArabic(kw))) score += 3;
  }

  for (const ent of queryAnalysis.detectedEntities) {
    if (haystack.includes(normalizeArabic(ent))) score += 5;
  }

  for (const art of queryAnalysis.detectedArticles) {
    if (haystack.includes(normalizeArabic(art))) score += 6;
  }

  return score;
}

function scoreLegalWeight(kind: SourceKind, domain: string, status: EnrichedSource["status"]): number {
  let score = 0;

  if (kind === "official") score += 100;
  if (kind === "explanatory") score += 55;
  if (kind === "professional") score += 20;

  if (SOURCE_LAYERS.official.some((d) => domain.endsWith(d))) score += 20;

  if (status === "ملغى") score -= 80;
  if (status === "قديم") score -= 30;
  if (status === "معدل") score -= 5;

  return score;
}

function scoreFreshness(item: SearchResult, status: EnrichedSource["status"]): number {
  let score = 0;

  if (item.publishDate) {
    const t = Date.parse(item.publishDate);
    if (!Number.isNaN(t)) {
      const ageDays = Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
      if (ageDays <= 30) score += 18;
      else if (ageDays <= 180) score += 12;
      else if (ageDays <= 365) score += 8;
      else if (ageDays <= 730) score += 4;
    }
  }

  if (status === "ملغى") score -= 20;
  if (status === "قديم") score -= 10;

  return score;
}

async function enrichAndRankSources(
  queryAnalysis: QueryAnalysis,
  rawResults: SearchResult[]
): Promise<EnrichedSource[]> {
  const deduped = dedupeResults(rawResults).slice(0, MAX_TOTAL_RESULTS);
  const out: EnrichedSource[] = [];

  for (const item of deduped) {
    const text = await extractText(item.url);
    const status = inferDocumentStatus(text, item.title);
    const relevanceScore = scoreRelevance(queryAnalysis, item, text);
    const legalWeight = scoreLegalWeight(item.sourceKind, item.domain, status);
    const freshnessScore = scoreFreshness(item, status);

    out.push({
      ...item,
      text,
      status,
      legalWeight,
      relevanceScore,
      freshnessScore,
      totalScore: legalWeight + relevanceScore + freshnessScore
    });
  }

  return out.sort((a, b) => b.totalScore - a.totalScore);
}

function splitSourcesForContext(items: EnrichedSource[]) {
  const official = items
    .filter((s) => s.sourceKind === "official" && s.status !== "ملغى")
    .slice(0, 5);

  const explanatory = items
    .filter((s) => s.sourceKind === "explanatory" && s.status !== "ملغى")
    .slice(0, 3);

  const professional = items
    .filter((s) => s.sourceKind === "professional")
    .slice(0, 3);

  return { official, explanatory, professional };
}

/* =========================
 * OpenAI helpers
 * ========================= */
function extractOpenAIText(data: any): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts: string[] = [];

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

async function callOpenAI(input: string, maxOutputTokens = 3000): Promise<string> {
  const resp = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      input,
      max_output_tokens: maxOutputTokens
    })
  }, 30000);

  const raw = await resp.text();

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`فشل قراءة استجابة OpenAI: ${raw}`);
  }

  if (!resp.ok) {
    throw new Error(data?.error?.message || "خطأ في OpenAI");
  }

  return extractOpenAIText(data);
}

function buildContextBlock(title: string, items: EnrichedSource[]) {
  if (!items.length) return `### ${title}\nلا يوجد.\n`;

  return `### ${title}\n` + items.map((s, i) => `
[${i + 1}]
العنوان: ${s.title}
النوع: ${s.sourceKind === "official" ? "رسمي" : s.sourceKind === "explanatory" ? "شارح" : "مهني"}
الرابط: ${s.url}
الجهة/النطاق: ${s.domain}
الحالة: ${s.status}
التاريخ: ${s.publishDate || "غير ظاهر"}
الملخص: ${s.snippet || "لا يوجد"}
النص المستخرج:
${s.text || "لم يمكن استخراج نص كافٍ."}
`).join("\n-----------------\n");
}

function estimateConfidence(officialCount: number, explanatoryCount: number): ConfidenceLevel {
  if (officialCount >= 2) return "مرتفع";
  if (officialCount >= 1 || explanatoryCount >= 2) return "متوسط";
  return "منخفض";
}

/* =========================
 * توليد الإجابة الأولية
 * ========================= */
function buildGenerationPrompt(
  query: string,
  analysis: QueryAnalysis,
  official: EnrichedSource[],
  explanatory: EnrichedSource[],
  professional: EnrichedSource[]
): string {
  const confidence = estimateConfidence(official.length, explanatory.length);

  return `
أنت مساعد قانوني سعودي داخل منصة أعراف القانونية.

المطلوب:
إعداد إجابة قانونية عربية بصيغة HTML فقط.

قواعد صارمة:
- اعتمد أولًا على الأنظمة واللوائح والقرارات والمصادر الرسمية السعودية.
- قدّم النص الرسمي أولًا.
- لا تبنِ الحكم النظامي على تغريدة أو منشور مهني.
- يجوز الاستفادة من المصادر الشارحة لشرح النص فقط.
- عند استخدام الآراء المهنية من وسائل التواصل، اعرضها فقط في قسم مستقل بعنوان "استزادة مهنية".
- إذا لم تجد نصًا سعوديًا رسميًا صريحًا، فاذكر ذلك بوضوح.
- لا تذكر أي معلومة غير مدعومة بالمصادر الموجودة في السياق.
- افصل دائمًا بين: الجواب النظامي، والتفصيل، والأساس النظامي، والمصادر الشارحة، والاستزادة المهنية.
- عند وجود أكثر من مصدر متقارب، قدّم الأحدث فالأحدث ما دام نافذًا ومرتبطًا بالسؤال.
- لا تذكر عبارة توحي بأن الرأي المهني ملزم.
- لا تضف markdown، ولا تكتب إلا HTML صالحًا.

بيانات السؤال:
- السؤال الأصلي: ${query}
- نوع السؤال: ${analysis.questionType}
- الكلمات المفتاحية: ${analysis.keywords.join("، ") || "غير محددة"}
- الكيانات المرصودة: ${analysis.detectedEntities.join("، ") || "غير محددة"}
- المواد المرصودة: ${analysis.detectedArticles.join("، ") || "غير محددة"}

السياق الرسمي:
${buildContextBlock("المصادر الرسمية", official)}

السياق الشارح:
${buildContextBlock("المصادر الشارحة", explanatory)}

السياق المهني:
${buildContextBlock("المصادر المهنية", professional)}

أنتج HTML بهذا الهيكل تقريبًا:

<section>
  <h2>عنوان الموضوع</h2>

  <h3>الجواب المختصر</h3>
  <p>...</p>

  <h3>التفصيل</h3>
  <p>...</p>
  <ul>
    <li>...</li>
  </ul>

  <h3>الأساس النظامي</h3>
  <ul>
    <li>...</li>
  </ul>

  <h3>المصادر الشارحة</h3>
  <ul>
    <li>...</li>
  </ul>

  <h3>استزادة مهنية</h3>
  <p>هذه الآراء تمثل اجتهادات أو قراءات مهنية غير رسمية، وتُعرض للاستزادة ولا تُعد نصوصًا نظامية ملزمة.</p>
  <ul>
    <li>...</li>
  </ul>

  <h3>مستوى الثقة</h3>
  <p>${confidence}</p>

  <h3>جميع المصادر</h3>
  <ul>
    <li>اسم المصدر — رسمي/شارح/مهني — الجهة — التاريخ — الحالة — الرابط</li>
  </ul>
</section>

قواعد إضافية:
- إذا لم توجد مصادر شارحة كافية، قل ذلك باقتضاب.
- إذا لم توجد استزادة مهنية مناسبة، ضع فقرة قصيرة تفيد بعدم توافر مادة مهنية موثوقة كافية.
- يجب أن تتضمن "جميع المصادر" كل مصدر استندت إليه فعلًا.
- لا تكرر المصدر الواحد أكثر من مرة داخل "جميع المصادر".
`;
}

/* =========================
 * طبقة التحقق
 * ========================= */
function buildVerifierPrompt(query: string, draftHtml: string, official: EnrichedSource[], explanatory: EnrichedSource[], professional: EnrichedSource[]) {
  return `
أنت طبقة تحقق قانونية داخل منصة أعراف القانونية.

المهمة:
راجع مسودة الإجابة التالية، ثم أعد كتابة نسخة HTML نهائية أكثر انضباطًا.

قواعد التحقق:
- احذف أو عدّل أي جملة غير مسندة إلى المصادر المرفقة.
- تأكد من أن الحكم النظامي مبني على المصادر الرسمية فقط.
- اسمح للمصادر الشارحة بالشرح لا بالإنشاء.
- اسمح للمصادر المهنية فقط في قسم "استزادة مهنية".
- إذا لم يظهر نص رسمي صريح، خفف الجزم.
- تأكد من إظهار الأحدث فالأحدث متى ظهر ذلك في السياق.
- تأكد من الفصل بين: الجواب المختصر، التفصيل، الأساس النظامي، المصادر الشارحة، استزادة مهنية، مستوى الثقة، جميع المصادر.
- لا تذكر أي شيء خارج HTML فقط.

السؤال:
${query}

المسودة:
${draftHtml}

المصادر الرسمية:
${buildContextBlock("المصادر الرسمية", official)}

المصادر الشارحة:
${buildContextBlock("المصادر الشارحة", explanatory)}

المصادر المهنية:
${buildContextBlock("المصادر المهنية", professional)}

أخرج HTML نهائي فقط.
`;
}

/* =========================
 * الخادم
 * ========================= */
export default async function handler(req: any, res: any) {
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

  if (!query || !String(query).trim()) {
    return res.status(400).json({ error: "يرجى إدخال السؤال" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY غير موجود" });
  }

  if (!process.env.SERPER_API_KEY) {
    return res.status(500).json({ error: "SERPER_API_KEY غير موجود" });
  }

  try {
    const analysis = analyzeQuery(String(query));
    const searchPlan = buildSearchQueries(analysis);

    const [
      officialBatch1,
      officialBatch2,
      officialBatch3,
      explanatoryBatch1,
      explanatoryBatch2,
      professionalBatch1
    ] = await Promise.all([
      serperSearch(searchPlan.officialQueries[0] || `${query} (${OFFICIAL_DOMAIN_FILTER})`, "official"),
      serperSearch(searchPlan.officialQueries[1] || `${query} نص نظام سعودي (${OFFICIAL_DOMAIN_FILTER})`, "official"),
      serperSearch(searchPlan.officialQueries[2] || `${query} لائحة قرار سعودي (${OFFICIAL_DOMAIN_FILTER})`, "official"),
      serperSearch(searchPlan.explanatoryQueries[0] || `${query} شرح قانوني سعودي (${EXPLANATORY_DOMAIN_FILTER})`, "explanatory"),
      serperSearch(searchPlan.explanatoryQueries[1] || `${query} مقال قانوني سعودي (${EXPLANATORY_DOMAIN_FILTER})`, "explanatory"),
      serperSearch(searchPlan.professionalQueries[0] || `${query} (${PROFESSIONAL_DOMAIN_FILTER})`, "professional")
    ]);

    const rankedSources = await enrichAndRankSources(analysis, [
      ...officialBatch1,
      ...officialBatch2,
      ...officialBatch3,
      ...explanatoryBatch1,
      ...explanatoryBatch2,
      ...professionalBatch1
    ]);

    const { official, explanatory, professional } = splitSourcesForContext(rankedSources);

    if (!official.length && !explanatory.length && !professional.length) {
      return res.status(200).json({
        content: `
<section>
  <h2>نتيجة البحث القانوني</h2>
  <h3>الجواب المختصر</h3>
  <p>لم يظهر في المصادر المتاحة ما يكفي لإنتاج جواب قانوني موثوق.</p>
  <h3>التفصيل</h3>
  <p>تعذر العثور على نصوص أو شروح كافية داخل النطاقات السعودية المحددة. يُفضّل إعادة صياغة السؤال بذكر اسم النظام أو المادة أو الجهة المختصة إن أمكن.</p>
  <h3>مستوى الثقة</h3>
  <p>منخفض</p>
</section>
        `.trim(),
        type: "إجابة قانونية",
        questionAnalysis: analysis,
        sources: []
      });
    }

    const generationPrompt = buildGenerationPrompt(query, analysis, official, explanatory, professional);
    const draftHtml = await callOpenAI(generationPrompt, 3200);

    const verifierPrompt = buildVerifierPrompt(query, draftHtml, official, explanatory, professional);
    const verifiedHtml = await callOpenAI(verifierPrompt, 3200);

    const usedSources = [...official, ...explanatory, ...professional].slice(0, MAX_CONTEXT_ITEMS);

    return res.status(200).json({
      content: verifiedHtml || draftHtml,
      type: "إجابة قانونية سعودية",
      questionAnalysis: analysis,
      confidence: estimateConfidence(official.length, explanatory.length),
      sources: usedSources.map((s) => ({
        title: s.title,
        url: s.url,
        snippet: s.snippet,
        sourceKind: s.sourceKind,
        domain: s.domain,
        publishDate: s.publishDate || null,
        status: s.status,
        score: s.totalScore
      }))
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || "خطأ غير متوقع"
    });
  }
}
