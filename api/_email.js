// ════════════════════════════════════════════════════════════════
//  MgLoot — helper e-mail partagé (le fichier commence par "_" donc
//  Vercel ne le transforme PAS en route API — il sert juste de module).
//
//  Utilise Resend si RESEND_API_KEY est présent, sinon Gmail (nodemailer).
//  Env possibles :
//    - RESEND_API_KEY + RESEND_FROM  (ex : "MgLoot <no-reply@mgloot.com>")
//    - ou GMAIL_USER + GMAIL_APP_PASSWORD (+ MAIL_FROM optionnel)
// ════════════════════════════════════════════════════════════════
let _mailer = null;

async function sendEmail(to, subject, html) {
  if (!to) return false;

  // 1) Resend (prioritaire si configuré)
  const RK = process.env.RESEND_API_KEY;
  if (RK) {
    try {
      const from = process.env.RESEND_FROM || process.env.MAIL_FROM || 'MgLoot <onboarding@resend.dev>';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + RK, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject, html })
      });
      if (r.ok) return true;
    } catch (e) { /* on tente Gmail ensuite */ }
  }

  // 2) Gmail (nodemailer)
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (user && pass) {
    try {
      const nodemailer = require('nodemailer');
      if (!_mailer) _mailer = nodemailer.createTransport({ service: 'gmail', auth: { user, pass: pass.replace(/\s+/g, '') } });
      const from = process.env.MAIL_FROM || ('MgLoot <' + user + '>');
      await _mailer.sendMail({ from, to, subject, html });
      return true;
    } catch (e) { return false; }
  }
  return false; // aucun service e-mail configuré
}

// Petit gabarit HTML MgLoot
function wrap(inner) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;background:#0b0b0d;color:#eee;border-radius:14px;overflow:hidden">'
    + '<div style="background:linear-gradient(135deg,#1c1c22,#0b0b0d);padding:20px;text-align:center">'
    + '<div style="font-size:26px;font-weight:800;color:#e8c766;letter-spacing:2px">◈ MGLOOT</div></div>'
    + '<div style="padding:22px;font-size:14px;line-height:1.7;color:#ddd">' + inner + '</div>'
    + '<div style="padding:14px;text-align:center;font-size:11px;color:#888;border-top:1px solid #222">MgLoot — https://mgloot.com</div></div>';
}

module.exports = { sendEmail, wrap };
