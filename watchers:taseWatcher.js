// watchers/taseWatcher.js
//
// מתחבר ל-API הרשמי של הבורסה לני"ע (TASE Data Hub - מוצר "MAYA Reports").
// ⚠️ לפני שזה יעבוד, צריך להשלים הרשמה (חד-פעמית, חינמית):
//
// 1. היכנס ל: https://datahub.tase.co.il (Developers Portal)
// 2. הירשם / התחבר עם חשבון TASE
// 3. צור "App" חדש (My Apps -> New App)
// 4. עבור למוצר "MAYA Reports" בקטלוג -> Register for Product -> Request Access
//    (זה מוצר חינמי, אבל עדיין דורש אישור - ייקח כמה ימים)
// 5. אחרי אישור: באפליקציה שלך -> Generate Credential -> תקבל API Key
// 6. בעמוד המוצר עצמו, לחץ "Try it out" כדי לראות את ה-Endpoint המדויק
//    ואת שם ה-Header הנכון להעברת המפתח (לרוב Ocp-Apim-Subscription-Key)
//
// מלא את 3 הערכים הבאים כ-Environment Variables ב-Render:
//   TASE_API_BASE_URL      - כתובת הבסיס של ה-API (תראה אותה בעמוד המוצר)
//   TASE_API_KEY           - המפתח שקיבלת
//   TASE_API_KEY_HEADER    - שם ה-header (ברירת מחדל: Ocp-Apim-Subscription-Key)

const axios = require('axios');

const TASE_API_BASE_URL = process.env.TASE_API_BASE_URL || '';
const TASE_API_KEY = process.env.TASE_API_KEY || '';
const TASE_API_KEY_HEADER = process.env.TASE_API_KEY_HEADER || 'Ocp-Apim-Subscription-Key';

// מילות מפתח שמעידות על כניסת גוף מוסדי / שינוי בעל עניין
const INSTITUTIONAL_KEYWORDS = [
  'בעל עניין',
  'בעל אמצעי שליטה',
  'שינוי בשיעור החזקות',
  'דוח על החזקות בעלי עניין',
  'הודעה על רכישה',
];

async function fetchLatestTaseReports() {
  if (!TASE_API_BASE_URL || !TASE_API_KEY) {
    console.warn('⚠️ TASE API לא מוגדר עדיין (חסר TASE_API_BASE_URL / TASE_API_KEY) - מדלג על הבדיקה');
    return [];
  }

  const res = await axios.get(TASE_API_BASE_URL, {
    headers: { [TASE_API_KEY_HEADER]: TASE_API_KEY },
  });

  // מבנה התשובה המדויק יתברר רק לאחר הרשמה - נניח מערך תחת res.data.result או res.data
  const reports = res.data.result || res.data || [];
  return reports;
}

function isInstitutionalReport(report) {
  const subject = (report.Subject || report.subject || report.Title || '').toString();
  return INSTITUTIONAL_KEYWORDS.some((kw) => subject.includes(kw));
}

async function checkTaseReports(pgPool) {
  const allReports = await fetchLatestTaseReports();
  const relevant = allReports.filter(isInstitutionalReport);

  const newReports = [];

  for (const report of relevant) {
    const reportId = String(report.ReportId || report.id || report.PublicationId);
    const existing = await pgPool.query(
      'SELECT 1 FROM seen_tase_reports WHERE report_id = $1',
      [reportId]
    );
    if (existing.rows.length === 0) {
      await pgPool.query(
        `INSERT INTO seen_tase_reports (report_id, company_name, subject, publish_date, url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (report_id) DO NOTHING`,
        [
          reportId,
          report.CompanyName || report.company_name || '',
          report.Subject || report.subject || '',
          report.PublishDate || report.publish_date || '',
          report.Url || report.url || '',
        ]
      );
      newReports.push(report);
    }
  }

  return newReports;
}

module.exports = { checkTaseReports, fetchLatestTaseReports };
