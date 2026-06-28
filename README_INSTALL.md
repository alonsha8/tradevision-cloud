# מודול התראות - הוראות התקנה

## מה כלול כאן

1. **`db/migration_watchers.sql`** - יצירת 2 טבלאות ב-PostgreSQL (למניעת התראות כפולות)
2. **`watchers/sponserWatcher.js`** - מעקב אחרי הודעות של היוזר "הדר" בפורום ספונסר
3. **`watchers/taseWatcher.js`** - מעקב אחרי דיווחים מיידיים על כניסת גופים מוסדיים (כל הבורסה), דרך ה-API הרשמי של TASE
4. **`watchers/emailAlert.js`** - שליחת מייל באמצעות EmailJS (REST, עובד מהשרת)
5. **`watchers/dailyCheck.js`** - מתזמן שמריץ את שני המעקבים פעם ביום ב-08:00

## שלבי התקנה

### 1. הוסף את הקבצים ל-repo
העבר את התיקייה `watchers/` ואת `db/migration_watchers.sql` לשורש הריפו שלך
(`alonsha8/tradevision-cloud`), לידי `server.js` ו-`package.json`.

### 2. הוסף ספריות חדשות
ב-`package.json`, תחת `dependencies`, הוסף (או הרץ `npm install` עם השמות הבאים):
```
npm install axios cheerio iconv-lite node-cron
```
(`pg` כבר קיים אצלך כי אתה מחובר ל-PostgreSQL)

### 3. צור את הטבלאות ב-DB
התחבר למסד הנתונים (PSQL Command מ-Render, או כל כלי GUI כמו pgAdmin/TablePlus)
והרץ את התוכן של `db/migration_watchers.sql`.

### 4. שלב ב-`server.js`
בסוף הקובץ, איפה שיש לך את חיבור ה-pgPool, הוסף:
```js
const startDailyWatcher = require('./watchers/dailyCheck');
startDailyWatcher(pgPool); // pgPool = אובייקט החיבור הקיים שלך ל-PostgreSQL
```

### 5. הרשמה ל-TASE Data Hub (חד פעמי, לוקח כמה ימים לאישור)
1. גלוש ל-https://datahub.tase.co.il והירשם
2. צור "App" חדש
3. בקטלוג המוצרים, מצא **MAYA Reports** ולחץ "Register for Product"
4. המתן לאישור (מוצר חינמי, אבל עדיין דורש אישור ידני מהבורסה)
5. אחרי האישור, צור API Key (Generate Credential) ובדוק בעמוד המוצר את:
   - כתובת ה-Endpoint המדויקת
   - שם ה-Header להעברת המפתח (כתבנו ברירת מחדל `Ocp-Apim-Subscription-Key`)

### 6. הוסף Environment Variables ב-Render
בעמוד ה-Web Service שלך (`tradevision-cloud-1`) → Environment, הוסף:
| משתנה | ערך |
|---|---|
| `TASE_API_BASE_URL` | הכתובת שתקבל מה-Developers Portal |
| `TASE_API_KEY` | המפתח שתקבל |
| `TASE_API_KEY_HEADER` | בד"כ `Ocp-Apim-Subscription-Key` (ודא בעמוד המוצר) |

### 7. ודא שה-template ב-EmailJS תואם
ה-template שלך (`template_4ekkj96`) צריך לכלול את המשתנים: `{{subject}}`, `{{message}}`, `{{link}}`.
אם השמות אחרים אצלך - עדכן ב-`watchers/emailAlert.js`.

## הערות חשובות

- **פורום ספונסר**: זה web scraping של אתר חיצוני. אם ספונסר ישנה את מבנה ה-HTML
  בעתיד, הפרסור עלול להישבר - תקבל שגיאה בלוג של Render ונצטרך לעדכן את הקוד.
- **המגבלה החינמית של TASE**: מוגבלת ל-100 בקשות ל-4 שבועות. בדיקה פעם ביום = כ-30
  בקשות בחודש, אז זה בהחלט מכוסה בנדיבות.
- **בדיקה ראשונית**: בריצה הראשונה, שני המעקבים "ירוצו על ריק" (לא יהיו רשומות ב-DB
  עדיין) ועלולים לשלוח כמות גדולה של מיילים על כל מה שכבר קיים. מומלץ להריץ פעם
  אחת ידנית ולבדוק, או להוסיף דגל "ריצה ראשונה - שמור בלי לשלוח מייל".
