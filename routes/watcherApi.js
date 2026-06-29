// routes/watcherApi.js
const express = require('express');
const { runCheckNow } = require('../watchers/dailyCheck');
const { ensureTable } = require('../watchers/sponserWatcher');

function createWatcherApi(pgPool) {
  const router = express.Router();

  router.get('/posts', async (req, res) => {
    try {
      await ensureTable(pgPool);
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
