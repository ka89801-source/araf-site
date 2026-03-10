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

function includesAny(text = "", words = []) {
  const normalized = normalizeArabic(text);
  return words.some((word) => normalized.includes(normalizeArabic(word)));
}

function detectContractType(query = "") {
  const text = normalizeArabic(query);

  if (
    text.includes("غير محدد المده") ||
    text.includes("غير محدد") ||
    text.includes("عقد غير محدد")
  ) {
    return "unlimited";
  }

  if (
    text.includes("محدد المده") ||
    text.includes("محدد") ||
    text.includes("عقد محدد")
  ) {
    return "limited";
  }

  return "unknown";
}

function detectUserTerms(query = "") {
  const terms = [];

  if (includesAny(query, ["استقالة", "استقال", "مستقيل"])) {
    terms.push("resignation");
  }

  if (includesAny(query, ["انهاء", "إنهاء", "اشعار", "إشعار"])) {
    terms.push("termination_notice");
  }

  if (includesAny(query, ["فسخ", "فسخت", "مفسوخ"])) {
    terms.push("rescission");
  }

  if (includesAny(query, ["فصل", "مفصول", "فصل تعسفي"])) {
    terms.push("dismissal");
  }

  if (includesAny(query, ["عدم تجديد", "لم يجدد", "عدم التمديد"])) {
    terms.push("non_renewal");
  }

  if (includesAny(query, ["بطلان", "باطل"])) {
    terms.push("nullity");
  }

  if (includesAny(query, ["عدم نفاذ", "غير نافذ"])) {
    terms.push("non_enforceability");
  }

  if (includesAny(query, ["شرط جزائي"])) {
    terms.push("penalty_clause");
  }

  if (includesAny(query, ["تعويض"])) {
    terms.push("compensation");
  }

  return terms;
}

function buildRuleResult({
  triggered = false,
  correctedQuery = "",
  correctedCharacterization = "",
  blockedTerms = [],
  warning = "",
  explanation = "",
  prioritySources = [],
  appliedRules = []
} = {}) {
  return {
    triggered,
    correctedQuery,
    correctedCharacterization,
    blockedTerms,
    warning,
    explanation,
    prioritySources,
    appliedRules
  };
}

/**
 * القواعد القانونية الصريحة
 * هذه ليست جوابًا قانونيًا نهائيًا،
 * بل بوابة تمنع النموذج من البناء على توصيف خاطئ.
 */
export function applyLegalRules(originalQuery = "") {
  const contractType = detectContractType(originalQuery);
  const userTerms = detectUserTerms(originalQuery);
  const normalizedQuery = normalizeArabic(originalQuery);

  /* =========================
     قاعدة 1:
     إذا ذُكرت "استقالة" مع "عقد غير محدد المدة"
     فلا تترك النموذج يبتلع اللفظ مباشرة.
  ========================= */
  if (contractType === "unlimited" && userTerms.includes("resignation")) {
    const correctedQuery = `
${originalQuery}

تنبيه قانوني داخلي:
لا تتعامل مع هذه الواقعة على أنها "استقالة" لمجرد ورود هذا اللفظ في السؤال.
تحقق أولًا من الوصف النظامي الصحيح في حالة العقد غير محدد المدة،
وركز على مسار:
- إنهاء العقد غير محدد المدة من قبل العامل بإشعار
- واستحقاق مكافأة نهاية الخدمة وفق التكييف الصحيح
- مع استبعاد أي حكم لا ينطبق لمجرد ورود لفظ الاستقالة
`.trim();

    return buildRuleResult({
      triggered: true,
      correctedQuery,
      correctedCharacterization: "فحص ما إذا كانت الواقعة في حقيقتها إنهاء لعقد غير محدد المدة بإشعار من العامل لا استقالة بالوصف المطبق آليًا.",
      blockedTerms: ["resignation"],
      warning: "ورد في السؤال لفظ قد يكون غير دقيق نظامًا بالنسبة إلى نوع العقد المذكور، فلا يجوز تطبيق أحكامه تلقائيًا.",
      explanation: "إذا اجتمع وصف الاستقالة مع العقد غير محدد المدة، يجب إجبار النظام على إعادة التكييف قبل تطبيق أحكام الاستقالة.",
      prioritySources: ["official", "twitter", "professional_article"],
      appliedRules: ["RULE_UNLIMITED_CONTRACT_RESIGNATION_RECHECK"]
    });
  }

  /* =========================
     قاعدة 2:
     إذا ذُكر "عدم تجديد" مع عقد محدد المدة
     فلا يُعامل فورًا كفصل
  ========================= */
  if (
    contractType === "limited" &&
    userTerms.includes("non_renewal") &&
    userTerms.includes("dismissal")
  ) {
    const correctedQuery = `
${originalQuery}

تنبيه قانوني داخلي:
لا تخلط بين عدم تجديد العقد المحدد المدة وبين الفصل.
تحقق أولًا:
- هل الواقعة هي مجرد عدم تجديد؟
- أم يوجد إنهاء قبل انتهاء المدة؟
- أم يوجد إجراء آخر يبرر وصف الفصل؟
`.trim();

    return buildRuleResult({
      triggered: true,
      correctedQuery,
      correctedCharacterization: "فحص الفرق بين عدم التجديد والفصل وعدم افتراض التطابق بينهما.",
      blockedTerms: ["dismissal"],
      warning: "وجود لفظ الفصل لا يكفي لتطبيق أحكامه إذا كانت الواقعة في حقيقتها عدم تجديد لعقد محدد المدة.",
      explanation: "هذه القاعدة تمنع الخلط بين مفهومي عدم التجديد والفصل.",
      prioritySources: ["official", "professional_article", "twitter"],
      appliedRules: ["RULE_NON_RENEWAL_NOT_AUTO_DISMISSAL"]
    });
  }

  /* =========================
     قاعدة 3:
     إذا ذُكر الفسخ مع واقعة ظاهرها إنهاء بإشعار
  ========================= */
  if (
    userTerms.includes("rescission") &&
    userTerms.includes("termination_notice")
  ) {
    const correctedQuery = `
${originalQuery}

تنبيه قانوني داخلي:
لا تفترض أن الفسخ والإنهاء بالإشعار شيء واحد.
افصل بين:
- الفسخ لسبب قانوني أو إخلال
- والإنهاء الصحيح بالإشعار
ثم طبّق الحكم المناسب فقط.
`.trim();

    return buildRuleResult({
      triggered: true,
      correctedQuery,
      correctedCharacterization: "فصل مسار الفسخ عن مسار الإنهاء بالإشعار.",
      blockedTerms: [],
      warning: "لا يجوز الخلط بين الفسخ والإنهاء النظامي بالإشعار.",
      explanation: "هذه القاعدة تمنع تداخل أثرين قانونيين مختلفين.",
      prioritySources: ["official", "academic", "professional_article"],
      appliedRules: ["RULE_RESCISSION_VS_TERMINATION_NOTICE"]
    });
  }

  /* =========================
     قاعدة 4:
     بطلان ≠ عدم نفاذ
  ========================= */
  if (
    userTerms.includes("nullity") &&
    userTerms.includes("non_enforceability")
  ) {
    const correctedQuery = `
${originalQuery}

تنبيه قانوني داخلي:
لا تعامل البطلان وعدم النفاذ على أنهما مترادفان.
يجب التحقق أولًا من الفرق بين:
- بطلان التصرف أو الشرط
- وعدم نفاذه في مواجهة طرف أو في حالة معينة
`.trim();

    return buildRuleResult({
      triggered: true,
      correctedQuery,
      correctedCharacterization: "فصل مفهومي البطلان وعدم النفاذ قبل بناء الجواب.",
      blockedTerms: [],
      warning: "البطلان وعدم النفاذ ليسا وصفًا واحدًا.",
      explanation: "هذه القاعدة تمنع الإجابة على فرضية تساوي بين مفهومين قانونيين مختلفين.",
      prioritySources: ["official", "academic"],
      appliedRules: ["RULE_NULLITY_VS_NON_ENFORCEABILITY"]
    });
  }

  /* =========================
     قاعدة 5:
     الشرط الجزائي ≠ التعويض دائمًا
  ========================= */
  if (
    userTerms.includes("penalty_clause") &&
    userTerms.includes("compensation")
  ) {
    const correctedQuery = `
${originalQuery}

تنبيه قانوني داخلي:
لا تفترض أن الشرط الجزائي والتعويض شيء واحد في جميع الأحوال.
افصل بين:
- الشرط الجزائي المتفق عليه
- والتعويض القضائي أو النظامي
ثم تحقق من العلاقة بينهما.
`.trim();

    return buildRuleResult({
      triggered: true,
      correctedQuery,
      correctedCharacterization: "فحص العلاقة بين الشرط الجزائي والتعويض دون افتراض التطابق الكامل بينهما.",
      blockedTerms: [],
      warning: "وجود لفظ التعويض مع الشرط الجزائي لا يعني اتحادهما دائمًا.",
      explanation: "هذه القاعدة تمنع الدمج التلقائي بين مفهومين متقاربين لكن غير متطابقين بالضرورة.",
      prioritySources: ["official", "academic", "professional_article"],
      appliedRules: ["RULE_PENALTY_CLAUSE_VS_COMPENSATION"]
    });
  }

  return buildRuleResult({
    triggered: false,
    correctedQuery: originalQuery,
    correctedCharacterization: "",
    blockedTerms: [],
    warning: "",
    explanation: "",
    prioritySources: ["official", "academic", "professional_article", "twitter", "tiktok"],
    appliedRules: []
  });
}
