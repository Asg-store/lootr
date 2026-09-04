// ════════════════════════════════════════════════════════════════
//  LootR — /api/send-push  (Fonction serverless Vercel, Node.js)
//  Envoie une VRAIE notification push FCM aux appareils d'un client,
//  même quand l'application est complètement fermée.
//
//  Body attendu (POST JSON) :
//    { userId?: string, token?: string, title: string, body: string, url?: string }
//    - userId  → envoie à tous les appareils de ce client (collection fcmTokens)
//    - token   → envoie à un appareil précis
//    - (aucun) → diffusion à TOUS les appareils (annonces générales)
//
//  ⚙️ Variable d'environnement REQUISE sur Vercel :
//    FIREBASE_SERVICE_ACCOUNT = le contenu JSON complet de votre clé de
//    compte de service Firebase (Console Firebase → Paramètres du projet →
//    Comptes de service → Générer une nouvelle clé privée).
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant (variable d\'environnement Vercel)');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) {
    cred.private_key = cred.private_key.replace(/\\n/g, '\n'); // corrige les retours à la ligne échappés
  }
  return admin.initializeApp({ credential: admin.credential.cert(cred) });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 🤖 Mode Gemini : réponse de l'assistant IA (fusionné ici pour rester sous 12 fonctions Vercel)
  //    Variable d'environnement Vercel requise : GEMINI_API_KEY
  {
    let _b = req.body;
    if (typeof _b === 'string') { try { _b = JSON.parse(_b || '{}'); } catch (e) { _b = {}; } }
    _b = _b || {};
    if (_b.mode === 'gemini') {
      const KEY = process.env.GEMINI_API_KEY;
      if (!KEY) return res.status(200).json({ reply: '', err: 'GEMINI_API_KEY absente sur Vercel' });
      const sys = "Tu es l'assistant virtuel de LootR, une application de recharges de jeux et marketplace. "
        + "LootR propose : recharges (UC PUBG Mobile, diamants Free Fire, CP Call of Duty, etc.), vente de comptes de jeu entre particuliers (Marketplace), une Boutique VPN, des points de fidélité, un portefeuille LootR, et un système de parrainage. "
        + "Moyens de paiement : Orange Money, Wave, PayPal, carte bancaire, et le portefeuille LootR. Après paiement validé, la livraison est automatique et rapide (UC/diamants livrés sur l'ID joueur ; identifiants de compte remis dans l'app). "
        + "Réponds TOUJOURS dans la langue du client, de façon courte, claire, polie et amicale (2 à 5 phrases max). Utilise quelques emojis avec parcimonie. "
        + "Tu ne peux PAS accéder au compte du client ni voir ses commandes en temps réel. Ne promets jamais de remboursement ou d'action que seul un humain peut faire. "
        + "Si le client veut parler à un vrai conseiller / administrateur / humain, ou si sa demande dépasse tes capacités (litige, paiement bloqué, remboursement, problème de compte), invite-le à taper « admin » pour être mis en relation avec un administrateur.";
      const history = Array.isArray(_b.history) ? _b.history.slice(-8) : [];
      const contents = [];
      history.forEach(function (h) {
        var t = String((h && h.text) || '').slice(0, 800); if (!t) return;
        contents.push({ role: (h.role === 'bot' || h.role === 'model') ? 'model' : 'user', parts: [{ text: t }] });
      });
      contents.push({ role: 'user', parts: [{ text: String(_b.message || '').slice(0, 2000) }] });
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(KEY), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: contents, generationConfig: { maxOutputTokens: 500, temperature: 0.6 } })
        });
        const d = await r.json();
        let text = '';
        try { text = (((d.candidates || [])[0] || {}).content || {}).parts.map(function (p) { return p.text || ''; }).join(''); } catch (e) { text = ''; }
        if (!text) {
          var em = '';
          try { em = (d && d.error && d.error.message) ? d.error.message : ('HTTP ' + r.status); } catch (e) { em = 'HTTP ' + r.status; }
          return res.status(200).json({ reply: '', err: 'Gemini: ' + String(em).slice(0, 160) });
        }
        return res.status(200).json({ reply: text.trim() });
      } catch (e) { return res.status(200).json({ reply: '', err: 'Exception: ' + String((e && e.message) || e).slice(0, 120) }); }
    }
  }

  try {
    getApp();
    const db = admin.firestore();

    let payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
    payload = payload || {};
    const { userId, token, title, body, url, type } = payload;

    // ── 📧 Envoi email OPTIONNEL (indépendant du push) ──────────────
    // Si le body contient email:{to,subject,html}, on envoie aussi un
    // email via le helper _email.js (Gmail/Resend). Utilisé notamment
    // quand l'admin change le statut d'une commande (livrée, annulée…).
    let emailSent = false;
    if (payload.email && payload.email.to) {
      try {
        const { sendEmail } = require('./_email.js');
        emailSent = await sendEmail(payload.email.to, payload.email.subject || 'LootR', payload.email.html || '');
      } catch (e) { emailSent = false; }
    }
    // Mode "email seul" : pas de push, on répond tout de suite.
    if (payload.emailOnly) return res.status(200).json({ ok: true, emailSent: emailSent });

    // ── Collecte des jetons cibles ──
    let tokens = [];
    if (token) tokens.push(token);
    if (userId) {
      const snap = await db.collection('fcmTokens').where('userId', '==', userId).get();
      snap.forEach(d => { const t = (d.data() && d.data().token) || d.id; if (t) tokens.push(t); });
    }
    if (!userId && !token) {
      const snap = await db.collection('fcmTokens').get(); // diffusion générale
      snap.forEach(d => { const t = (d.data() && d.data().token) || d.id; if (t) tokens.push(t); });
    }
    tokens = Array.from(new Set(tokens));
    if (!tokens.length) return res.status(200).json({ ok: true, sent: 0, note: 'aucun appareil enregistré' });

    // ── Lien ABSOLU (obligatoire pour le Web Push : FCM refuse un lien relatif) ──
    // On dérive l'origine du site depuis la requête, sinon on retombe sur lootr.cc.
    const _host = (req.headers['x-forwarded-host'] || req.headers.host || 'lootr.cc').split(',')[0].trim();
    const _origin = 'https://' + _host.replace(/^https?:\/\//, '');
    // URL d'ouverture : /?open=<type> → l'app ouvre directement la bonne section.
    const _openUrl = _origin + '/?open=' + encodeURIComponent(String(type || ''));
    const _iconUrl = _origin + '/notif-logo.png';
    const _badgeUrl = _origin + '/notif-badge.png';

    const base = {
      // data → utilisé au premier plan (onMessage) et pour le routage
      data: {
        title: String(title || 'LootR'),
        body: String(body || ''),
        url: _openUrl,
        type: String(type || ''),
        icon: _iconUrl
      },
      // Priorité HAUTE pour l'app Android native (WebView / FCM natif)
      android: { priority: 'high' },
      // ⚠️ WEB / PWA : le bloc "android" est ignoré par le Web Push.
      //  • On fournit un bloc "notification" → le navigateur AFFICHE la notif
      //    lui-même, en priorité utilisateur : elle arrive même APP FERMÉE,
      //    sans attendre la réouverture (contrairement à un message "data" seul
      //    qui est souvent mis en file d'attente par Android/Doze).
      //  • Urgency:high + TTL → livraison immédiate, gardée 24 h si hors ligne.
      //  • fcmOptions.link (ABSOLU) → section ouverte au clic.
      webpush: {
        headers: {
          Urgency: 'high',
          TTL: '86400'
        },
        notification: {
          title: String(title || 'LootR'),
          body: String(body || ''),
          icon: _iconUrl,
          badge: _badgeUrl,
          requireInteraction: true,
          data: { type: String(type || ''), url: _openUrl }
        },
        fcmOptions: { link: _openUrl }
      }
    };

    let success = 0, failure = 0; const stale = [];
    for (let i = 0; i < tokens.length; i += 500) {
      const batch = tokens.slice(i, i + 500);
      const resp = await admin.messaging().sendEachForMulticast(Object.assign({}, base, { tokens: batch }));
      success += resp.successCount; failure += resp.failureCount;
      resp.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = (r.error && r.error.code) || '';
          if (code.indexOf('registration-token-not-registered') >= 0 || code.indexOf('invalid-argument') >= 0) {
            stale.push(batch[idx]);
          }
        }
      });
    }
    // Nettoyage des jetons expirés
    await Promise.all(stale.map(t => db.collection('fcmTokens').doc(t).delete().catch(() => {})));

    return res.status(200).json({ ok: true, sent: success, failed: failure, cleaned: stale.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
