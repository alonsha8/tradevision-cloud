// watchers/sponserWatcher.js
//
// סורק את לובי פורום ספונסר אחרי הודעות מהיוזרים הנעקבים.
// כשמתגלה הודעה חדשה — שולף את תוכנה המלא וקורא ל-Claude (Haiku)
// כדי לבדוק אם היא רלוונטית: קנייה / מכירה / ניתוח עם תמיכות+יעדים.
// הודעות לא רלוונטיות (שאלות כלליות, ברכות וכו') נשמרות ב-DB אבל לא מתריעות.

const axios = require('axios');
const iconv = require('iconv-lite');
const cheerio = require('cheerio');

const LOBBY_URL = 'https://www.sponser.co.il/ForumLobby.aspx';
const TARGET_USERNAMES = ['הדר', 'דובי'];

// מילות מפתח לסינון Fallback (אם ה-AI נכשל)
const RELEVANT_KEYWORDS = [
  'קניתי','נכנסתי','רכשתי','כניסה ל','פתחתי','הוספתי',
  'מכרתי','יצאתי','סגרתי','ממושש','ממוש',
  'תמיכה','תמיכות','יעד','יעדים','התנגדות','סטופ','stop','ממליץ'
];

async function ensureTable(pgPool) {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS seen_forum_posts (
      id SERIAL PRIMARY KEY,
      msg_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      forum_id TEXT,
      title TEXT,
      url TEXT,
      ai_summary TEXT,
      post_type TEXT,
      seen_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // הוסף עמודות חדשות אם הטבלה כבר קיימת בלי אותן
  await pgPool.query(`ALTER TABLE seen_forum_posts ADD COLUMN IF NOT EXISTS ai_summary TEXT`);
  await pgPool.query(`ALTER TABLE seen_forum_posts ADD COLUMN IF NOT EXISTS post_type TEXT`);
}

// שולף את תוכן ההודעה המלאה מהעמוד בפורום
async function fetchPostContent(url) {
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0 (TradeVisionWatcher/1.0)' },
      timeout: 10000
    });
    const html = iconv.decode(Buffer.from(res.data), 'windows-1255');
    const $ = cheerio.load(html);

    // ננסה כמה סלקטורים נפוצים לתוכן הודעה בפורום
    const selectors = ['td.msgBody', '.msgBody', '.message-body', '.post-content', '.msg-content', 'td[class*="msg"]'];
    for (const sel of selectors) {
      const el = $(sel).first();
      if (el.length && el.text().trim().length > 10) {
        return el.text().replace(/\s+/g, ' ').trim().slice(0, 1500);
      }
    }
    // Fallback: כל ה-<p> בעמוד
    const paragraphs = $('p').map((_, el) => $(el).text().trim()).get().filter(t => t.length > 5);
    return paragraphs.join(' ').slice(0, 1500);
  } catch (err) {
    console.error('שגיאה בטעינת תוכן הודעה:', err.message);
    return '';
  }
}

// מסווג את ההודעה עם Claude Haiku — מהיר וזול
async function classifyWithAI(title, content, username) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // ללא מפתח API — fallback למילות מפתח
    const combined = (title + ' ' + content).toLowerCase();
    const relevant = RELEVANT_KEYWORDS.some(kw => combined.includes(kw));
    return { relevant, summary: title, type: 'general', ticker: null };
  }

  const msgText = `כותרת: ${title}\n\nתוכן: ${content || '(לא זמין)'}`;
  const prompt = `אתה מנתח הודעות מפורום שוק ההון הישראלי.
המשתמש "${username}" כתב את ההודעה הבאה:

${msgText}

האם ההודעה מדברת על אחד מהנושאים הבאים?
1. רכישת מניה / כניסה לפוזיציה
2. מכירת מניה / יציאה מפוזיציה
3. ניתוח טכני עם תמיכות / התנגדויות / יעדים על מניה ספציפית

ענה רק ב-JSON (ללא תגי קוד):
{"relevant":true/false,"type":"buy"/"sell"/"analysis"/"other","summary":"תמצית 1-2 משפטים בעברית","ticker":"סימול המניה או null"}

אם ההודעה לא קשורה לנושאים אלה (שאלה כללית, ברכה, דיון שוקי כללי) — החזר relevant:false.`;

  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 20000
    });

    const raw = res.data.content[0].text.trim();
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (err) {
    console.error('שגיאה בסיווג AI:', err.message);
    // fallback למילות מפתח
    const combined = (title + ' ' + content).toLowerCase();
    const relevant = RELEVANT_KEYWORDS.some(kw => combined.includes(kw));
    return { relevant, summary: title, type: 'general', ticker: null };
  }
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
      date, time,
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

  const newRelevantPosts = [];

  for (const post of matches) {
    const existing = await pgPool.query(
      'SELECT 1 FROM seen_forum_posts WHERE msg_id = $1',
      [post.msgId]
    );
    if (existing.rows.length === 0) {
      console.log(`🤖 מסווג הודעה מ-${post.username}: "${post.title}"`);

      // שולף תוכן מלא ומסווג עם AI
      const content = await fetchPostContent(post.url);
      const classification = await classifyWithAI(post.title, content, post.username);

      // שומר ב-DB תמיד (גם אם לא רלוונטי — כדי לא לעבד שוב)
      await pgPool.query(
        `INSERT INTO seen_forum_posts (msg_id, username, forum_id, title, url, ai_summary, post_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (msg_id) DO NOTHING`,
        [post.msgId, post.username, post.forumId, post.title, post.url,
         classification.summary || post.title, classification.type || 'other']
      );

      if (classification.relevant) {
        console.log(`✅ הודעה רלוונטית (${classification.type}): ${classification.summary}`);
        newRelevantPosts.push({
          ...post,
          ai_summary: classification.summary,
          post_type: classification.type,
          ticker: classification.ticker
        });
      } else {
        console.log(`⏭️ לא רלוונטי (${classification.type}), נדלג`);
      }
    }
  }

  return newRelevantPosts;
}

module.exports = { checkSponserForum, fetchLatestForumPosts, TARGET_USERNAMES, ensureTable };
