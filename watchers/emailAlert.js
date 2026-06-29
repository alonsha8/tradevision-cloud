// watchers/emailAlert.js
// שליחת מייל באמצעות EmailJS REST API (עובד מצד שרת, לא רק מהדפדפן)
// משתמש בפרטים הקיימים שלך מ-TradeVision: service_q8gw0ao / template_4ekkj96

const axios = require('axios');

const EMAILJS_SERVICE_ID = 'service_q8gw0ao';
const EMAILJS_TEMPLATE_ID = 'template_4ekkj96';
const EMAILJS_PUBLIC_KEY = 'LkDpHo19XM92ZLmZm';

/**
 * שולח התראת מייל.
 * @param {Object} params - { subject, message, link }
 * חשוב: ה-template ב-EmailJS חייב להכיל את אותם שמות משתנים
 * (subject, message, link) - אם השמות אצלך אחרים, התאם כאן.
 */
async function sendAlertEmail({ subject, message, link }) {
  try {
    const response = await axios.post('https://api.emailjs.com/api/v1.0/email/send', {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      template_params: {
        subject,
        message,
        link: link || '',
      },
    });
    console.log(`✅ מייל נשלח בהצלחה: ${subject}`);
    return response.data;
  } catch (err) {
    console.error('❌ שגיאה בשליחת מייל:', err.response ? err.response.data : err.message);
    throw err;
  }
}

module.exports = { sendAlertEmail };
