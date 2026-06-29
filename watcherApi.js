// routes/watcherApi.js
//
// מספק 2 endpoints ל-API שמשמשים את דאשבורד המעקב (public/watcher.html):
//   GET  /api/watcher/posts      - מחזיר את ההודעות האחרונות שנמצאו
//   POST /api/watcher/check-now  - מריץ בדיקה ידנית מיידית בפורום ספונסר
//
// שימוש ב-server.js:
//   const createWatcherApi = require('./routes/watcherApi');
//   if (pool) app.use('/api/watcher', createWatcherApi(pool));

const express = require('express');
const { runCheckNow } = require('../watchers/dailyCheck');

function createWatcherApi(pgPool) {
  const router = express.Router();

  // מחזיר את 50 ההודעות האחרונות שזוהו, מהחדש לישן
  router.get('/posts', async (req, res) => {
    try {
      const result = await pgPool.query(
        `SELECT msg_id, username, forum_id, title, url, seen_at
         FROM seen_forum_posts
         ORDER BY seen_at DESC
         LIMIT 50`
      );
      res.json({ posts: result.rows });
    } catch (err) {
      console.error('שגיאה בשליפת הודעות:', err.message);
      res.status(500).json({ error: 'שגיאה בשליפת ההודעות' });
    }
  });

  // מריץ בדיקה ידנית מיידית ומחזיר את מה שנמצא (אם נמצא משהו חדש)
  router.post('/check-now', async (req, res) => {
    try {
      const newPosts = await runCheckNow(pgPool);
      res.json({ success: true, newPostsFound: newPosts.length, newPosts });
    } catch (err) {
      console.error('שגיאה בבדיקה ידנית:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = createWatcherApi;
