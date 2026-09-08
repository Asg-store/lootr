// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/flashtopup-deliver  (Fonction serverless Vercel)
//  Livraison AUTOMATIQUE d'une commande via l'API FlashTopup Reseller v2.
//
//  Body attendu (POST JSON) : { "orderId": "<id commande Firestore>" }
//
//  Auth FlashTopup : signature HMAC-SHA256 (identique au plugin officiel) :
//    Headers : X-FT-API-ID, X-FT-Timestamp, X-FT-Nonce, X-FT-Signature
//    canonical = "POST\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + sha256(rawBody)
//    signature = hmac_sha256(canonical, API_KEY)
//    (tous les appels sont en POST, même les lectures)
//
//  Fonctionnement :
//    1. Lit orders/{orderId} (firebase-admin).
//    2. Vérifie : payée, pas déjà livrée via FlashTopup.
//    3. Pour chaque article → son `ftServiceCode` (code service FlashTopup,
//       renseigné dans l'admin). target = l'ID joueur de la commande.
//    4. POST /order { service_code, reference_id, quantity, user_id, server_id? }
//    5. Sonde POST /order/status { reference_id } (≈12s) → statut "completed".
//    6. Si tout "completed" → commande "delivered" + notification client.
//
//  ⚙️ Variables d'environnement Vercel REQUISES :
//     - FIREBASE_SERVICE_ACCOUNT   (déjà utilisée par send-push.js)
//     - FLASHTOPUP_API_ID          (ton API ID FlashTopup, ex: RSZ...)
//     - FLASHTOPUP_API_KEY         (ta clé SECRÈTE — RÉGÉNÈRE-LA, jamais dans le code)
//     - FLASHTOPUP_BASE_URL        (optionnel, défaut: https://api.flashtopup.com/api/reseller/v2)
//     - FLASHTOPUP_SANDBOX         (optionnel: "true" pour tester en bac à sable)
//     - FT_PROXY_URL               (optionnel: proxy à IP FIXE pour la whitelist
//                                   FlashTopup, ex: http://user:pass@proxy.host:port
//                                   — via Fixie / QuotaGuard Static. Vercel ayant des
//                                   IP dynamiques, ce proxy donne une IP unique à
//                                   inscrire dans la whitelist FlashTopup.)
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
const crypto = require('crypto');

// Sortie via proxy à IP fixe si FT_PROXY_URL est défini (sinon fetch normal).
// Ex FT_PROXY_URL : http://user:pass@31.59.20.176:6754  (Webshare, Fixie, etc.)
let _ftAgent = null;
function _buildFtAgent(proxy) {
  const { ProxyAgent } = require('undici');
  const u = new URL(proxy);
  const cfg = { uri: u.protocol + '//' + u.host }; // endpoint du proxy, sans identifiants
  if (u.username || u.password) {
    const cred = decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password);
    cfg.token = 'Basic ' + Buffer.from(cred).toString('base64'); // auth proxy fiable
  }
  return new ProxyAgent(cfg);
}
async function doFetch(url, opts) {
  const proxy = process.env.FT_PROXY_URL;
  if (proxy) {
    const { fetch: uFetch } = require('undici');
    if (!_ftAgent) _ftAgent = _buildFtAgent(proxy);
    return uFetch(url, Object.assign({}, opts, { dispatcher: _ftAgent }));
  }
  return fetch(url, opts);
}

const BASE = (process.env.FLASHTOPUP_BASE_URL || 'https://api.flashtopup.com/api/reseller/v2').replace(/\/+$/, '');
const SANDBOX = String(process.env.FLASHTOPUP_SANDBOX || '').toLowerCase() === 'true';

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  return admin.initializeApp({ credential: admin.credential.cert(cred) });
}

// Appel signé à l'API FlashTopup (toujours POST)
async function ft(endpoint, body) {
  const url = BASE + endpoint;
  const path = new URL(url).pathname;                 // ex: /api/reseller/v2/order
  const rawBody = (body && Object.keys(body).length) ? JSON.stringify(body) : '{}';
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(12).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const canonical = 'POST\n' + path + '\n' + ts + '\n' + nonce + '\n' + bodyHash;
  const signature = crypto.createHmac('sha256', process.env.FLASHTOPUP_API_KEY || '').update(canonical).digest('hex');

  const headers = {
    'X-FT-API-ID': process.env.FLASHTOPUP_API_ID || '',
    'X-FT-Timestamp': ts,
    'X-FT-Nonce': nonce,
    'X-FT-Signature': signature,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  if (SANDBOX) headers['X-FT-Sandbox'] = 'true';

  const res = await doFetch(url, { method: 'POST', headers: headers, body: rawBody });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  const ok = !!(json && ((json.success === true) || (json.status === true) || (json.status === 'success'))) && res.status < 400;
  const err = (json && json.error) || {};
  const msg = (err.message) || (typeof (json && json.message) === 'string' ? json.message : '') || '';
  const code = err.code ? String(err.code) : (res.status >= 400 ? ('HTTP_' + res.status) : '');
  return { ok: ok, http: res.status, data: (json && json.data) || null, message: msg, code: code, raw: json };
}

// Lit le statut de commande depuis les diverses formes de réponse
function readOrderStatus(d) {
  if (!d) return '';
  const o = d.data || d;
  return String(o.order_status || o.status || o.state || '').toLowerCase();
}
const DONE = ['completed', 'success', 'delivered', 'done'];
const FAILED = ['failed', 'error', 'cancelled', 'canceled', 'refunded'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 📲 Envoie un push FCM à tous les appareils d'un client — via /api/send-push
//    (format "data" fiable en arrière-plan, géré par le service worker)
async function pushToUser(db, uid, title, body) {
  try {
    const BASE = (process.env.PUBLIC_BASE_URL || 'https://mgloot.com').replace(/\/+$/, '');
    await fetch(BASE + '/api/send-push', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: uid, title: title, body: body, url: '/' })
    });
  } catch (e) {}
}
// 📧 Email (Resend ou Gmail) — via le helper partagé
let _mailMod = null;
function mailMod() { if (!_mailMod) { try { _mailMod = require('./_email.js'); } catch (e) { _mailMod = { sendEmail: async () => false, wrap: (x) => x }; } } return _mailMod; }
async function sendMail(to, subject, html) { return mailMod().sendEmail(to, subject, html); }
function mailWrap(inner) { return mailMod().wrap(inner); }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!process.env.FLASHTOPUP_API_KEY || !process.env.FLASHTOPUP_API_ID) {
      return res.status(500).json({ error: 'FLASHTOPUP_API_ID / FLASHTOPUP_API_KEY manquants (variables Vercel)' });
    }
    getApp();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;

    let payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
    const orderId = (payload && payload.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'orderId requis' });

    const orderRef = db.collection('orders').doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Commande introuvable' });
    const order = snap.data() || {};

    if (order.ftStatus === 'success') return res.status(200).json({ ok: true, note: 'déjà livrée via FlashTopup' });
    if (['paid', 'delivered', 'processing', 'shipped'].indexOf(order.status) < 0) {
      return res.status(400).json({ error: 'Commande non payée (statut: ' + (order.status || '—') + ')' });
    }

    const target = String(order.playerId || (order.account && (order.account.userId || order.account.konamiId)) || '').trim();
    if (!target) return res.status(400).json({ error: 'ID joueur (user_id) manquant sur la commande' });
    const serverId = String(order.serverId || (order.account && order.account.serverId) || '').trim();

    // Construit les tâches depuis les articles + le mapping produit (code service FlashTopup)
    const items = order.items || [];
    const tasks = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let code = it.ftServiceCode || it.sancayProductId || '';
      if (!code && it.id) {
        try {
          const p = await db.collection('products').doc(it.id).get();
          if (p.exists) { const pd = p.data() || {}; code = pd.ftServiceCode || pd.sancayProductId || ''; }
        } catch (e) {}
      }
      if (!code) continue; // article non mappé → ignoré
      tasks.push({ service_code: code, reference_id: orderId + '-' + i, quantity: Math.max(1, it.qty || 1) });
    }
    if (!tasks.length) return res.status(400).json({ error: 'Aucun article mappé (renseignez le "code service FlashTopup" dans l\'admin)' });

    // 1) Passe les commandes (idempotent grâce à reference_id)
    const refs = [];
    for (let t = 0; t < tasks.length; t++) {
      const body = {
        service_code: tasks[t].service_code,
        reference_id: tasks[t].reference_id,
        quantity: tasks[t].quantity,
        user_id: target
      };
      if (serverId) body.server_id = serverId;
      const r = await ft('/order', body);
      let st = readOrderStatus(r);
      if (!r.ok && !st) st = 'failed';
      refs.push({ ref: tasks[t].reference_id, ok: r.ok, status: st, code: r.code || '', msg: r.message });
    }

    // 2) Sonde le statut jusqu'à ~1 minute pour laisser le temps à la livraison d'aboutir
    let allDone = false;
    for (let attempt = 0; attempt < 19 && !allDone; attempt++) {
      await sleep(3000);   // 19 × 3s ≈ 57s
      allDone = true;
      for (let k = 0; k < refs.length; k++) {
        if (DONE.indexOf(refs[k].status) >= 0) continue;
        const s = await ft('/order/status', { reference_id: refs[k].ref });
        refs[k].status = readOrderStatus(s) || refs[k].status;
        if (s.code && !refs[k].code) refs[k].code = s.code;
        if (s.message && !refs[k].msg) refs[k].msg = s.message;
        if (DONE.indexOf(refs[k].status) < 0) allDone = false;
      }
    }

    const anyFailed = refs.some(r => FAILED.indexOf(r.status) >= 0);
    const allSuccess = refs.length > 0 && refs.every(r => DONE.indexOf(r.status) >= 0);

    // 3) Met à jour la commande + notifie
    const update = {
      ftRefs: refs.map(r => r.ref),
      ftLastStatus: refs.map(r => r.status).join(','),
      ftCheckedAt: FieldValue.serverTimestamp()
    };
    if (allSuccess) {
      update.status = 'delivered';
      update.ftStatus = 'success';
      update.deliveredAt = FieldValue.serverTimestamp();
    } else if (anyFailed) {
      update.ftStatus = 'failed';
    } else {
      update.ftStatus = 'pending';
    }
    // Trace de la raison en cas de souci (visible dans Firestore + réponse, pour diagnostic)
    const problem = refs.find(function (r) { return r.code || FAILED.indexOf(r.status) >= 0; });
    if (problem) update.ftError = ((problem.code ? problem.code + ': ' : '') + (problem.msg || '')).slice(0, 300);
    await orderRef.set(update, { merge: true });

    if (allSuccess && order.userId) {
      const cref = 'CMD-' + String(orderId).slice(0, 6).toUpperCase();
      const bodyTxt = 'Votre recharge (' + cref + ') a été livrée automatiquement sur l\'ID ' + target + '.';
      try {
        await db.collection('users').doc(order.userId).collection('notifications').add({
          icon: '✅', title: 'Commande livrée !',
          body: bodyTxt,
          type: 'order', link: 'payments', refId: orderId, read: false,
          createdAt: FieldValue.serverTimestamp()
        });
      } catch (e) {}
      // 📲 Push téléphone (même app fermée)
      try { await pushToUser(db, order.userId, '✅ Commande livrée !', bodyTxt); } catch (e) {}
      // 📧 Email récapitulatif au client
      try {
        const em = order.email || '';
        if (em) {
          const items = (order.items || []).map(function (it) { return '• ' + (it.qty || 1) + '× ' + (it.name || '') ; }).join('<br>');
          const html = mailWrap(
            '<h2 style="color:#e8c766;margin:0 0 10px">✅ Commande livrée</h2>'
            + '<p>Bonjour ' + (order.userName || '') + ',</p>'
            + '<p>Votre commande <b>' + cref + '</b> a été livrée automatiquement.</p>'
            + '<div style="background:#141418;border-radius:10px;padding:14px;margin:12px 0">'
            + (items ? ('<b>Articles :</b><br>' + items + '<br><br>') : '')
            + '<b>ID joueur :</b> ' + target + '<br>'
            + '<b>Total :</b> ' + ((+order.total || 0).toFixed(2)) + ' €'
            + '</div>'
            + '<p>Merci pour votre confiance ! 🎮</p>'
          );
          await sendMail(em, 'Commande ' + cref + ' livrée — MgLoot', html);
        }
      } catch (e) {}
    }

    const problem2 = refs.find(function (r) { return r.code || FAILED.indexOf(r.status) >= 0; });
    return res.status(200).json({
      ok: true, orderId: orderId, delivered: allSuccess,
      status: allSuccess ? 'delivered' : (anyFailed ? 'failed' : 'pending'),
      error: problem2 ? ((problem2.code ? problem2.code + ': ' : '') + (problem2.msg || '')) : null,
      sandbox: SANDBOX,
      refs: refs
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
