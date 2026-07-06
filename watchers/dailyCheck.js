// watchers/dailyCheck.js
//
// מריץ אוטומטית 3 פעמים ביום (10:15, 14:00, 16:00 - שעון ישראל) מעקב אחרי
// הודעות חדשות ורלוונטיות מהיוזרים "הדר" ו"דובי" בפורום ספונסר.
// רק הודעות שסווגו ע"י Claude AI כרלוונטיות (קנייה/מכירה/ניתוח) יגיעו כהתראה.

const cron = require('node-cron');
const { checkSponserForum } = require('./sponserWatcher');
const { sendAlertEmail } = require('./emailAlert');

const TYPE_LABELS = {
  buy: '🟢 קנייה',
  sell: '🔴 מכירה',
  analysis: '🔵 ניתוח טכני',
  general: '📌 כללי',
  other: '📌 כללי'
};

async function runCheckNow(pgPool) {
  console.log('🔍 מריץ בדיקה בפורום ספונסר...');
  const newPosts = await checkSponserForum(pgPool);

  for (const post of newPosts) {
    const typeLabel = TYPE_LABELS[post.post_type] || '📌';
    const tickerNote = post.ticker ? ` | מניה: ${post.ticker}` : '';
    await sendAlertEmail({
      subject: `${typeLabel} | ${post.username} כתב בפורום ספונסר${tickerNote}`,
      message: post.ai_summary || post.title,
      link: post.url,
    });
  }

  console.log(`✅ פורום ספונסר: ${newPosts.length} הודעות רלוונטיות חדשות נמצאו ונשלחו`);
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
