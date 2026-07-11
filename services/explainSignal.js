// explainSignal.js
//
// Turns the raw numeric signals + verdict into a full plain-language Hebrew
// explanation for each sector row:
//   1. תמונת מצב - the raw data, always stated (not just when a threshold fires)
//   2. למה הציון הזה - which specific factors pushed the score up/down
//   3. המלצה - what to actually do about it, in plain terms
//
// This is intentionally more verbose than a one-liner - Alon asked for the
// full reasoning behind every score, not just a summary tag.

const FLAG_EXPLANATIONS = {
  rs_strengthening_multiweek: (s) =>
    `RS מול המדד מתחזק ${s.rsTrend.weeksConsistent} שבועות רצוף - זה איתות חזק ועקבי, לא רעש חד-פעמי (+30 נק')`,
  rs_strengthening_early: () =>
    `RS מתחיל להתחזק אבל עדיין לא במגמה עקבית של כמה שבועות - מוקדם מדי לקבוע שזו מגמה אמיתית (+10 נק')`,
  rs_weakening_multiweek: (s) =>
    `RS מול המדד נחלש ${s.rsTrend.weeksConsistent} שבועות רצוף - הסקטור מפגר אחרי המדד בעקביות (-30 נק')`,
  rs_weakening_early: () =>
    `RS מתחיל להיחלש אבל עדיין לא במגמה מבוססת - ייתכן שזה רעש זמני (-10 נק')`,
  volume_anomaly_accumulation: (s) =>
    `נפח המסחר עלה ${s.relativeVolume.relativeVolumePct}% מהממוצע בלי שהמחיר קפץ בהתאם - זה בדיוק הדפוס של כסף נכנס בשקט לפני שהציבור שם לב (+15 נק')`,
  "52w_low_drying_up": (s) =>
    `הסקטור לא יצר שפל 52 שבועות חדש כבר ${s.lowBehavior.daysSinceLastNewLow} ימי מסחר, למרות שהוא לא רץ הרבה - לחץ המוכרים נראה נחלש, קלאסי לשלב accumulation מוקדם (+20 נק')`,
  chase_risk_major_rally: (s) =>
    `הסקטור כבר עלה ${s.runUp.runUpPct}% מהשפל השנתי - זו רמת עלייה שמנוגדת ישירות לעיקרון שלך "לא לרדוף אחרי ראלי", גם אם שאר האיתותים חיוביים (-40 נק', הכי כבד בניקוד)`,
  caution_moderate_rally: (s) =>
    `עלייה מתונה של ${s.runUp.runUpPct}% מהשפל השנתי - עדיין לא ברמת "רדיפה", אבל לא כניסה על שפל טהור (-15 נק')`,
};

const VERDICT_META = {
  candidate: {
    label: "מועמד רציני - איתות מוקדם, טרם נרדף",
    recommendation: (sectorLabel, instruments) =>
      `הייתי מתחיל לעקוב מקרוב ושוקל כניסה ראשונה חלקית (לא lump-sum, בהתאם לעיקרון הכניסה המדורגת שלך) באחת מתעודות הסל: ${instruments}. זה בדיוק הסוג של איתות שביקשת - מוקדם, לא נרדף, עם נתונים תומכים.`,
  },
  early_candidate: {
    label: "איתות ראשוני - עדיין מוקדם לאישור",
    recommendation: () =>
      `הייתי שם את הסקטור הזה ברשימת מעקב פעילה, אבל לא נכנס עדיין - האיתות טרי מדי (פחות מ-3 שבועות עקביים). אם הוא ימשיך להתחזק בסריקות הבאות, זה עולה ל"מועמד רציני".`,
  },
  too_late: {
    label: "איתות חיובי אך מאוחר - סיכון רדיפה אחרי מגמה",
    recommendation: () =>
      `למרות שה-RS עדיין חיובי, הסקטור כבר עלה הרבה מדי מהשפל - כניסה עכשיו זו בדיוק הרדיפה שהעיקרון שלך אומר להימנע ממנה. הייתי מחכה לפולבק (ירידה זמנית) לפני שיקול כניסה, לא רץ אחרי המחיר.`,
  },
  weakening: {
    label: "סימני היחלשות - רלוונטי אם אתה מחזיק בסקטור",
    recommendation: () =>
      `אם אתה כבר מחזיק בסקטור הזה - זה האיתות שביקשת בשביל האחזקות הקיימות. לא בהכרח סיבה למכור מיד, אבל סיבה טובה להעלות ערנות ולבדוק שוב בסריקה הבאה אם ההיחלשות נמשכת. אם אתה לא מחזיק - זו לא הזדמנות כניסה כרגע.`,
  },
  watch_only: {
    label: "לצפייה בלבד - אין עדיין איתות ברור",
    recommendation: () =>
      `אין כאן כרגע מספיק נתונים שמצדיקים פעולה בכל כיוון - לא כניסה ולא יציאה. הייתי פשוט משאיר את זה ברשימת המעקב השוטפת.`,
  },
};

function describeRawState(signals) {
  const { rsTrend, relativeVolume, lowBehavior, runUp } = signals;
  const bits = [];

  if (rsTrend.direction === "insufficient_data") {
    bits.push("אין עדיין מספיק היסטוריית מחירים לחישוב מגמת RS אמינה");
  } else {
    const dirWord = rsTrend.direction === "strengthening" ? "מתחזק" : rsTrend.direction === "weakening" ? "נחלש" : "יציב";
    bits.push(`RS מול המדד ${dirWord} בקצב ${rsTrend.slopePerWeek}%/שבוע (${rsTrend.weeksConsistent} שבועות עקביים)`);
  }

  if (relativeVolume.sufficientData) {
    bits.push(`נפח המסחר ${relativeVolume.relativeVolumePct > 0 ? "גבוה" : "נמוך"} ב-${Math.abs(relativeVolume.relativeVolumePct)}% מהממוצע`);
  }

  if (lowBehavior.hasEnoughHistory) {
    bits.push(
      lowBehavior.isDryingUp
        ? `לא נוצר שפל 52 שבועות חדש כבר ${lowBehavior.daysSinceLastNewLow} ימי מסחר`
        : `שפל 52 שבועות אחרון היה לפני ${lowBehavior.daysSinceLastNewLow} ימי מסחר (עדיין פעיל/לא רלוונטי כרגע)`
    );
  }

  if (runUp.sufficientData) {
    bits.push(`המחיר הנוכחי גבוה ב-${runUp.runUpPct}% מהשפל השנתי`);
  }

  return bits.join(", ") + ".";
}

function explainSignal(sectorLabel, signals, scoring, instruments) {
  const rawState = describeRawState(signals);

  const breakdown = scoring.flags.length
    ? scoring.flags.map((f) => (FLAG_EXPLANATIONS[f] ? FLAG_EXPLANATIONS[f](signals) : f)).join(". ") + "."
    : "אף אחד מהאיתותים לא היה חזק מספיק כדי לזוז מהניקוד הנייטרלי (50).";

  const verdictMeta = VERDICT_META[scoring.verdict] || VERDICT_META.watch_only;
  const instrumentsStr = (instruments || []).map((i) => i.name || i.ticker).join(" / ") || "אין תעודת סל מזוהה";
  const recommendation = verdictMeta.recommendation(sectorLabel, instrumentsStr);

  const explanation =
    `${sectorLabel} (ציון ${scoring.score}/100): תמונת מצב - ${rawState} ` +
    `למה הציון הזה: ${breakdown} ` +
    `מה הייתי עושה במקומך: ${recommendation}`;

  return {
    sectorLabel,
    verdictLabel: verdictMeta.label,
    explanation,
  };
}

module.exports = { explainSignal };
