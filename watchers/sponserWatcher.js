// watchers/sponserWatcher.js
// בודק את עמוד "לובי הפורומים" של ספונסר (https://www.sponser.co.il/ForumLobby.aspx)
// ומחפש הודעות חדשות מהיוזרים שהוגדרו (TARGET_USERNAMES), בכל הפורומים בבת אחת.

const axios = require('axios');
const iconv = require('iconv-lite');
const cheerio = require('cheerio');

const LOBBY_URL = 'https://www.sponser.co.il/ForumLobby.aspx';
const TARGET_USERNAMES = ['הדר', 'דובי'];

async function ensureTable(pgPool) {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS seen_forum_posts (
      id SERIAL PRIMARY KEY,
      msg_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      forum_id TEXT,
      title TEXT,
      url TEXT,
      seen_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function fetchLatestForumPosts() {
  const res = await axios.get(LOBBY_URL, {
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'Mozilla/5.0 (TradeVisionWatcher/1.0)' },
  });

  const html = iconv.decode(Buffer.from(res.data), 'windows-1255');
  const $ = cheerio.load(html);

  const posts = [];

  $('a[href*="Forum.aspx?ForumId="][href*="MsgId="]').each((_, el) => {
    const href = $(el).attr('href');
    const rawText = $(el).text().replace(/\s+/g, ' ').trim();

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

async function checkSponserForum(pgPool) {
  await ensureTable(pgPool);
  const posts = await fetchLatestForumPosts();
  const matches = posts.filter((p) =>
    TARGET_USERNAMES.some((name) => p.username === name || p.username.includes(name))
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

module.exports = { checkSponserForum, fetchLatestForumPosts, TARGET_USERNAMES, ensureTable };
