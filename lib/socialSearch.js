// lib/socialSearch.js

const SOCIAL_PLATFORMS = {
  twitter: "twitter",
  tiktok: "tiktok"
};

function normalizeArabic(text = "") {
  return String(text)
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .toLowerCase()
    .trim();
}

function unique(arr = []) {
  return [...new Set(arr.filter(Boolean))];
}

function isSaudiLegalRelevantText(text = "") {
  const normalized = normalizeArabic(text);

  const saudiTerms = [
    "السعوديه",
    "المملكه العربيه السعوديه",
    "نظام العمل السعودي",
    "النظام السعودي",
    "وزارة الموارد البشريه",
    "وزارة العدل",
    "وزارة التجاره",
    "هيئة الخبراء",
    "ديوان المظالم",
    "التامينات الاجتماعيه",
    "المحاكم السعوديه",
    "القانون السعودي",
    "محامي سعودي",
    "موارد بشريه",
    "السعودي",
    "saudi",
    "ksa"
  ];

  const legalTerms = [
    "نظام",
    "لائحه",
    "ماده",
    "عقد",
    "انهاء",
    "استقاله",
    "فسخ",
    "فصل",
    "تعويض",
    "مكافاه نهايه الخدمه",
    "شرط جزائي",
    "بطلان",
    "عدم نفاذ",
    "عمل",
    "عمال",
    "موارد بشريه",
    "قضيه",
    "دعوى"
  ];

  const hasSaudi = saudiTerms.some((term) => normalized.includes(term));
  const hasLegal = legalTerms.some((term) => normalized.includes(term));

  return hasSaudi && hasLegal;
}

function getPlatformFromUrl(url = "") {
  const lower = String(url).toLowerCase();

  if (lower.includes("x.com") || lower.includes("twitter.com")) {
    return SOCIAL_PLATFORMS.twitter;
  }

  if (lower.includes("tiktok.com")) {
    return SOCIAL_PLATFORMS.tiktok;
  }

  return "other";
}

function buildTwitterQueries(query = "") {
  return unique([
    `site:x.com ${query} السعودية قانون`,
    `site:x.com ${query} "نظام العمل السعودي"`,
    `site:x.com ${query} "وزارة الموارد البشرية"`,
    `site:twitter.com ${query} السعودية قانون`,
    `site:twitter.com ${query} "نظام سعودي"`
  ]);
}

function buildTikTokQueries(query = "") {
  return unique([
    `site:tiktok.com ${query} السعودية قانون`,
    `site:tiktok.com ${query} "نظام العمل السعودي"`,
    `site:tiktok.com ${query} "محامي سعودي"`,
    `site:tiktok.com ${query} "موارد بشرية" السعودية`
  ]);
}

function scoreSocialResult(item = {}, originalQuery = "") {
  const combined = `${item.title || ""} ${item.snippet || ""} ${item.url || ""}`;
  const normalizedCombined = normalizeArabic(combined);
  const normalizedQuery = normalizeArabic(originalQuery);

  let score = 0;

  if (getPlatformFromUrl(item.url) === SOCIAL_PLATFORMS.twitter) score += 20;
  if (getPlatformFromUrl(item.url) === SOCIAL_PLATFORMS.tiktok) score += 14;

  if (isSaudiLegalRelevantText(combined)) score += 30;

  if (normalizedCombined.includes("السعود")) score += 8;
  if (normalizedCombined.includes("نظام")) score += 8;
  if (normalizedCombined.includes("ماده")) score += 6;
  if (normalizedCombined.includes("وزارة الموارد")) score += 10;
  if (normalizedCombined.includes("هيئة الخبراء")) score += 10;
  if (normalizedCombined.includes("محامي")) score += 6;
  if (normalizedCombined.includes("موارد بشريه")) score += 6;

  const queryWords = normalizedQuery.split(/\s+/).filter(Boolean);
  for (const word of queryWords) {
    if (word.length >= 2 && normalizedCombined.includes(word)) {
      score += 3;
    }
  }

  return score;
}

function dedupeByUrl(items = []) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    if (!item?.url) continue;

    let normalizedUrl = item.url.trim();

    try {
      const u = new URL(normalizedUrl);
      u.hash = "";
      normalizedUrl = u.toString();
    } catch {
      continue;
    }

    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);

    out.push({
      ...item,
      url: normalizedUrl
    });
  }

  return out;
}

function filterSocialResults(items = []) {
  return items.filter((item) => {
    const platform = getPlatformFromUrl(item.url);
    if (platform !== SOCIAL_PLATFORMS.twitter && platform !== SOCIAL_PLATFORMS.tiktok) {
      return false;
    }

    return isSaudiLegalRelevantText(`${item.title || ""} ${item.snippet || ""} ${item.url || ""}`);
  });
}

/**
 * serperSearchFn:
 * دالة تمرر من ask.js وتكون مسؤولة عن تنفيذ البحث عبر Serper.
 * يجب أن تعيد مصفوفة عناصر بشكل:
 * { title, url, snippet }
 */
export async function searchSocialSources(query, serperSearchFn) {
  if (!query || typeof serperSearchFn !== "function") {
    return [];
  }

  const twitterQueries = buildTwitterQueries(query);
  const tiktokQueries = buildTikTokQueries(query);

  const allQueries = [...twitterQueries, ...tiktokQueries];

  const settled = await Promise.allSettled(
    allQueries.map((q) => serperSearchFn(q))
  );

  const rawResults = [];

  for (const result of settled) {
    if (result.status === "fulfilled" && Array.isArray(result.value)) {
      rawResults.push(...result.value);
    }
  }

  const deduped = dedupeByUrl(rawResults);
  const filtered = filterSocialResults(deduped);

  return filtered
    .map((item) => ({
      ...item,
      sourcePlatform: getPlatformFromUrl(item.url),
      sourceType:
        getPlatformFromUrl(item.url) === SOCIAL_PLATFORMS.twitter
          ? "إكس / تويتر"
          : "تيك توك",
      socialScore: scoreSocialResult(item, query)
    }))
    .sort((a, b) => b.socialScore - a.socialScore)
    .slice(0, 12);
}
