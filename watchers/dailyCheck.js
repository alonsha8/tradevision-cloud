// watchers/dailyCheck.js
//
// מריץ פעם ביום (08:00 לפי שעון ישראל) את שני המעקבים:
// 1. הודעות חדשות מהיוזר "הדר" בפורום ספונסר
// 2. דיווחים מיידיים חדשים על כניסת גופים מוסדיים, מכל הבורסה
//
// כדי להפעיל: require('./watchers/dailyCheck')(pgPool); בתוך server.js שלך,
// אחרי שה-pgPool (חיבור ה-DB) כבר מוגדר.

const cron = require('node-cron');
const { checkSponserForum } = require('./sponserWatcher');
const { checkTaseReports } = require('./taseWatcher');
const { sendAlertEmail } = require('./emailAlert');

function startDailyWatcher(pgPool) {
  // "0 8 * * *" = כל יום בשעה 08:00
  cron.schedule(
    '0 8 * * *',
    async () => {
      console.log('🔍 מריץ בדיקה יומית (פורום ספונסר + דיווחי מאיה)...');

      try {
        const newPosts = await checkSponserForum(pgPool);
        for (const post of newPosts) {
          await sendAlertEmail({
            subject: `הדר פרסם הודעה חדשה בפורום ספונסר`,
            message: `${post.title}\n\nתאריך: ${post.date} ${post.time}`,
            link: post.url,
          });
        }
        console.log(`✅ פורום ספונסר: ${newPosts.length} הודעות חדשות נמצאו ונשלחו`);
      } catch (err) {
        console.error('❌ שגיאה בבדיקת פורום ספונסר:', err.message);
      }

      try {
        const newReports = await checkTaseReports(pgPool);
        for (const report of newReports) {
          await sendAlertEmail({
            subject: `דיווח מיידי חדש - כניסת גוף מוסדי: ${report.CompanyName || report.company_name || ''}`,
            message: report.Subject || report.subject || '',
            link: report.Url || report.url || '',
          });
        }
        console.log(`✅ דיווחי מאיה: ${newReports.length} דיווחים חדשים נמצאו ונשלחו`);
      } catch (err) {
        console.error('❌ שגיאה בבדיקת דיווחי מאיה:', err.message);
      }
    },
    { timezone: 'Asia/Jerusalem' }
  );

  console.log('⏰ Watcher יומי מתוזמן ל-08:00 (שעון ישראל)');
}

module.exports = startDailyWatcher;
