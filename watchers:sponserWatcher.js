// watchers/sponserWatcher.js
// בודק את עמוד "לובי הפורומים" של ספונסר (https://www.sponser.co.il/ForumLobby.aspx)
// ומחפש הודעות חדשות מהיוזר שהוגדר (TARGET_USERNAME), בכל הפורומים בבת אחת.
//
// שים לב: זהו web scraping של אתר חיצוני - מבנה ה-HTML יכול להשתנות בעתיד
// ולשבור את הפרסור. אם זה קורה, יש לבדוק מחדש את מבנה העמוד.

const axios = require('axios');
const iconv = require('iconv-lite');
const cheerio = require('cheerio');

const LOBBY_URL = 'https://www.sponser.co.il/ForumLobby.aspx';
const TARGET_USERNAME = 'הדר'; // <-- הכינוי שביקשת לעקוב אחריו

/**
 * שולף את כל הודעות הפורום המוצגות בעמוד הלובי, עם הכינוי, הכותרת והקישור.
 */
async function fetchLatestForumPosts() {
  const res = await axios.get(LOBBY_URL, {
    responseType: 'arraybuffer', // חשוב - האתר בקידוד windows-1255 (עברית ישנה)
    headers: { 'User-Agent': 'Mozilla/5.0 (TradeVisionWatcher/1.0)' },
  });

  const html = iconv.decode(Buffer.from(res.data), 'windows-1255');
  const $ = cheerio.load(html);

  const posts = [];

  $('a[href*="Forum.aspx?ForumId="][href*="MsgId="]').each((_, el) => {
    const href = $(el).attr('href');
    const rawText = $(el).text().replace(/\s+/g, ' ').trim();

    // הטקסט מסתיים בדרך כלל ב: "<כותרת> <כינוי> dd/mm/yy hh:mm"
    const match = rawText.match(/^(.*?)\s+(\S+)\s+(\d{2}\/\d{2}\/\d{2})\s+(\d{2}:\d{2})$/);
    if (!match) return;

    const [, title, username, date, time] = match;

    const msgIdMatch = href.match(/MsgId=(\d+)/);
    const forumIdMatch = href.match(/ForumId=(\d+)/);

    posts.push({
      msgId: msgIdMatch ? msgIdMatch[1] : href,
      forumId: forumIdMatch ? forumIdMatch[1] : null,
      title: title.replace(/^■\s*/, '').trim(),
      username: username.trim(),
      date,
      time,
      url: href.startsWith('http') ? href : `https://www.sponser.co.il/${href}`,
    });
  });

  return posts;
}

/**
 * מריץ בדיקה: שולף הודעות, מסנן רק את אלו מהיוזר המבוקש שלא נראו בעבר,
 * שומר אותן ב-DB, ומחזיר רשימה של הודעות חדשות לשליחת התראה.
 */
async function checkSponserForum(pgPool) {
  const posts = await fetchLatestForumPosts();
  const matches = posts.filter(
    (p) => p.username === TARGET_USERNAME || p.username.includes(TARGET_USERNAME)
  );

  const newPosts = [];

  for (const post of matches) {
    const existing = await pgPool.query(
      'SELECT 1 FROM seen_forum_posts WHERE msg_id = $1',
      [post.msgId]
    );
    if (existing.rows.length === 0) {
      await pgPool.query(
        `INSERT INTO seen_forum_posts (msg_id, username, forum_id, title, url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (msg_id) DO NOTHING`,
        [post.msgId, post.username, post.forumId, post.title, post.url]
      );
      newPosts.push(post);
    }
  }

  return newPosts;
}

module.exports = { checkSponserForum, fetchLatestForumPosts, TARGET_USERNAME };
