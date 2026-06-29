-- מעקב הודעות פורום ספונסר שכבר נשלחה עליהן התראה (כדי לא לשלוח כפול)
CREATE TABLE IF NOT EXISTS seen_forum_posts (
  id SERIAL PRIMARY KEY,
  msg_id TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  forum_id TEXT,
  title TEXT,
  url TEXT,
  seen_at TIMESTAMP DEFAULT NOW()
);

-- מעקב דיווחים מיידיים ממאיה (הבורסה) שכבר נשלחה עליהם התראה
CREATE TABLE IF NOT EXISTS seen_tase_reports (
  id SERIAL PRIMARY KEY,
  report_id TEXT UNIQUE NOT NULL,
  company_name TEXT,
  subject TEXT,
  publish_date TEXT,
  url TEXT,
  seen_at TIMESTAMP DEFAULT NOW()
);
