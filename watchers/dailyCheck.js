// watchers/dailyCheck.js
//
// מריץ אוטומטית 3 פעמים ביום (10:15, 14:00, 16:00 - שעון ישראל) מעקב אחרי
// הודעות חדשות מהיוזרים "הדר" ו"דובי" בפורום ספונסר, ושולח התראת מייל על כל הודעה חדשה.
//
// כדי להפעיל: require('./watchers/dailyCheck')(pgPool); בתוך server.js שלך,
// אחרי שה-pgPool (חיבור ה-DB) כבר מוגדר.
//
// יש כאן גם פונקציה runCheckNow(pgPool) שמאפשרת הרצה ידנית (למשל מ-route ב-server.js).

const cron = require('node-cron');
const { checkSponserForum } = require('./sponserWatcher');
const { sendAlertEmail } = require('./emailAlert');

async function runCheckNow(pgPool) {
  console.log('🔍 מריץ בדיקה בפורום ספונסר...');
  const newPosts = await checkSponserForum(pgPool);

  for (const post of newPosts) {
    await sendAlertEmail({
      subject: `${post.username} פרסם הודעה חדשה בפורום ספונסר`,
      message: `${post.title}\n\nתאריך: ${post.date} ${post.time}`,
      link: post.url,
    });
  }

  console.log(`✅ פורום ספונסר: ${newPosts.length} הודעות חדשות נמצאו ונשלחו`);
  return newPosts;
}

function startDailyWatcher(pgPool) {
  const times = [
    { cronExpr: '15 10 * * *', label: '10:15' },
    { cronExpr: '0 14 * * *', label: '14:00' },
    { cronExpr: '0 16 * * *', label: '16:00' },
  ];

  times.forEach(({ cronExpr, label }) => {
    cron.schedule(
      cronExpr,
      async () => {
        try {
          await runCheckNow(pgPool);
        } catch (err) {
          console.error(`❌ שגיאה בבדיקת פורום ספונסר (${label}):`, err.message);
        }
      },
      { timezone: 'Asia/Jerusalem' }
    );
  });

  console.log(
    '⏰ Watcher מתוזמן ל-10:15, 14:00, 16:00 (שעון ישראל) - עוקב אחרי: הדר, דובי'
  );
}

module.exports = startDailyWatcher;
module.exports.runCheckNow = runCheckNow;
