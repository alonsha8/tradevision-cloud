// explainIL.js
//
// Same three-part format as the US explainSignal.js:
//   1. תמונת מצב - the raw data
//   2. למה הציון הזה - which flags moved the score
//   3. מה הייתי עושה במקומך - concrete recommendation
//
// Adapted for Israeli sectors' snapshot-based data source.

const FLAG_EXPLANATIONS = {
  il_trend_positive_multiday: (s) =>
    `לאורך ${s.trend.daysTracked} ימי מעקב, השינוי היומי הממוצע חיובי (${s.trend.avgDailyChangePct}%/יום) עם ${s.trend.streak} ימים רצופים באותו כיוון - זו מגמה מצטברת אמיתית, לא תנועה יומית בודדת (+35 נק')`,
  il_trend_positive_early: (s) =>
    `השינוי היומי הממוצע לאורך ${s.trend.daysTracked} ימי מעקב חיובי אך חלש (${s.trend.avgDailyChangePct}%/יום) - כיוון חיובי, עדיין לא מגמה מבוססת (+12 נק')`,
  il_trend_negative_multiday: (s) =>
    `לאורך ${s.trend.daysTracked} ימי מעקב, השינוי היומי הממוצע שלילי (${s.trend.avgDailyChangePct}%/יום) עם ${s.trend.streak} ימים רצופים באותו כיוון - מגמת היחלשות מצטברת (-35 נק')`,
  il_trend_negative_early: (s) =>
    `השינוי היומי הממוצע לאורך ${s.trend.daysTracked} ימי מעקב שלילי אך חלש (${s.trend.avgDailyChangePct}%/יום) (-12 נק')`,
  il_limited_history: (s) =>
    `יש רק ${s.trend.daysTracked || 0} ימי מעקב שנצברו עד כה במערכת - עדיין מוקדם לקבוע מגמה אמיתית, נדרשים 5 ימים לפחות לאיתות מבוסס. ככל שהסריקה תרוץ עוד ימים, הדיוק יעלה אוטומטית`,
  il_daily_move_positive: (s) => `היום בלבד: עלייה של ${s.dailyChangePct}% - נתון יומי בודד, לא מגמה (+8 נק')`,
  il_daily_move_negative: (s) => `היום בלבד: ירידה של ${s.dailyChangePct}% - נתון יומי בודד, לא מגמה (-8 נק')`,
  il_valuation_expensive_percentile: (s) =>
    `מכפיל הרווח (${s.peRatio}) גבוה יותר מ-${s.peRankPercentile}% מכלל הסקטורים הישראליים שנסרקו כרגע - יקר יחסית לשוק המקומי, סימן זהירות בהתאם לעיקרון "לא לקנות בשיא" (-20 נק')`,
  il_valuation_cheap_percentile: (s) =>
    `מכפיל הרווח (${s.peRatio}) נמוך מ-${100 - s.peRankPercentile}% מכלל הסקטורים הישראליים שנסרקו כרגע - זול יחסית לשוק המקומי (+15 נק')`,
};

const VERDICT_META = {
  candidate: {
    label: "מועמד רציני - מגמה מצטברת חיובית, לא יקר יחסית",
    recommendation: (instruments) =>
      `יש כאן מגמה מצטברת אמיתית (לא רק יום אחד) שנתמכת גם בכך שהסקטור לא יקר יחסית לשוק המקומי. הייתי שוקל כניסה ראשונה חלקית. תעודות ידועות בתיק שלך שקשורות לסקטור: ${instruments}. אם אין לך תעודה מוכרת - תבדוק בעצמך איזו קרן עוקבת אחרי המדד הזה.`,
  },
  early_candidate: {
    label: "איתות ראשוני - עדיין מוקדם, ממתין לעוד נתונים",
    recommendation: () =>
      `הכיוון חיובי אבל עדיין אין מספיק ימי מעקב כדי לקרוא לזה מגמה מאושרת. הייתי שם ברשימת מעקב ובודק שוב בעוד כמה ימים - ככל שהמערכת תצבור עוד נתונים, האיתות הזה יתחזק או ייעלם.`,
  },
  too_late: {
    label: "מגמה חיובית אך יקר יחסית - זהירות",
    recommendation: () =>
      `יש מגמה חיובית, אבל מכפיל הרווח כבר גבוה יחסית לשאר הסקטורים המקומיים - כניסה כאן פחות תואמת את העיקרון של "לא לקנות בשיא". הייתי ממתין לפולבק או לירידה יחסית במכפיל לפני שיקול כניסה.`,
  },
  weakening: {
    label: "סימני היחלשות",
    recommendation: () =>
      `אם אתה כבר מחזיק בסקטור הזה - זה איתות שכדאי לשים לב אליו. אם לא - זו לא הזדמנות כניסה כרגע.`,
  },
  watch_only: {
    label: "לצפייה בלבד - אין עדיין איתות ברור",
    recommendation: () =>
      `אין כרגע מספיק נתונים או תנועה משמעותית שמצדיקה פעולה. ברשימת המעקב השוטפת בלבד.`,
  },
};

function describeRawState(signals) {
  const bits = [];
  bits.push(`שינוי יומי: ${signals.dailyChangePct > 0 ? "+" : ""}${signals.dailyChangePct}%`);
  bits.push(`מכפיל רווח: ${signals.peRatio}${signals.peRankPercentile !== null ? ` (יקר יותר מ-${signals.peRankPercentile}% מהסקטורים שנסרקו)` : ""}`);
  bits.push(`מכפיל הון: ${signals.pbRatio}`);
  bits.push(`תשואת דיבידנד: ${signals.dividendYieldPct}%`);
  if (signals.trend.sufficientData) {
    bits.push(`${signals.trend.daysTracked} ימי מעקב שנצברו, שינוי יומי ממוצע ${signals.trend.avgDailyChangePct}%`);
  } else {
    bits.push(`רק ${signals.history ? signals.history.length : 0} ימי מעקב נצברו עד כה (צריך 5 לפחות לאיתות מגמה)`);
  }
  return bits.join(", ") + ".";
}

function explainILSignal(sectorLabel, signals, scoring, instruments) {
  const rawState = describeRawState(signals);
  const breakdown = scoring.flags.length
    ? scoring.flags.map((f) => (FLAG_EXPLANATIONS[f] ? FLAG_EXPLANATIONS[f](signals) : f)).join(". ") + "."
    : "אין כרגע איתות משמעותי.";

  const verdictMeta = VERDICT_META[scoring.verdict] || VERDICT_META.watch_only;
  const instrumentsStr = (instruments || []).map((i) => i.name).join(" / ") || "אין תעודה ידועה מתועדת - יש לבדוק עצמאית";
  const recommendation = verdictMeta.recommendation(instrumentsStr);

  const explanation =
    `${sectorLabel} (ציון ${scoring.score}/100): תמונת מצב - ${rawState} ` +
    `למה הציון הזה: ${breakdown} ` +
    `מה הייתי עושה במקומך: ${recommendation}`;

  return { sectorLabel, verdictLabel: verdictMeta.label, explanation };
}

module.exports = { explainILSignal };
