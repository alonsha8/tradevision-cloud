// watchers/dailyCheck.js
//
// מריץ פעם ביום (08:00 לפי שעון ישראל) מעקב אחרי הודעות חדשות
// מהיוזרים "הדר" ו"דובי" בפורום ספונסר, ושולח התראת מייל על כל הודעה חדשה.
//
// כדי להפעיל: require('./watchers/dailyCheck')(pgPool); בתוך server.js שלך,
// אחרי שה-pgPool (חיבור ה-DB) כבר מוגדר.

const cron = require('node-cron');
const { checkSponserForum } = require('./sponserWatcher');
const { sendAlertEmail } = require('./emailAlert');

function startDailyWatcher(pgPool) {
  // "0 8 * * *" = כל יום בשעה 08:00
  cron.schedule(
    '0 8 * * *',
    async () => {
      console.log('🔍 מריץ בדיקה יומית בפורום ספונסר...');

      try {
        const newPosts = await checkSponserForum(pgPool);
        for (const post of newPosts) {
          await sendAlertEmail({
            subject: `${post.username} פרסם הודעה חדשה בפורום ספונסר`,
            message: `${post.title}\n\nתאריך: ${post.date} ${post.time}`,
            link: post.url,
          });
        }
        console.log(`✅ פורום ספונסר: ${newPosts.length} הודעות חדשות נמצאו ונשלחו`);
      } catch (err) {
        console.error('❌ שגיאה בבדיקת פורום ספונסר:', err.message);
      }
    },
    { timezone: 'Asia/Jerusalem' }
  );

  console.log('⏰ Watcher יומי מתוזמן ל-08:00 (שעון ישראל) - עוקב אחרי: הדר, דובי');
}

module.exports = startDailyWatcher;
