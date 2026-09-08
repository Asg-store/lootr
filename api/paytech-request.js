// ════════════════════════════════════════════════════════════════
//  LootR — /api/paytech-request  (créer un paiement PayTech.sn)
//
//  Flux : le client demande une recharge → cette fonction crée la
//  session de paiement chez PayTech et renvoie l'URL de redirection.
//  Le client est redirigé vers PayTech (Orange Money, Wave, Free, carte…).
//  Quand le paiement réussit, PayTech appelle /api/paytech-ipn qui
//  crédite le portefeuille côté serveur (sécurisé, anti-doublon).
//
//  Sécurité : vérifie le jeton Firebase du client (on connaît le vrai uid).
//  Env Vercel REQUISES :
//    - PAYTECH_API_KEY      (clé API PayTech)
//    - PAYTECH_API_SECRET   (clé secrète PayTech)
//    - PAYTECH_ENV          ('test' ou 'prod', défaut 'test')
//    - PUBLIC_BASE_URL      (ex : https://mgloot.com)  ← pour les URLs de retour/IPN
//    - FIREBASE_SERVICE_ACCOUNT (déjà présente)
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  return admin.initializeApp({ credential: admin.credential.cert(cred) });
}

const EUR_XOF = 655.957;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const API_KEY = process.env.PAYTECH_API_KEY;
    const API_SECRET = process.env.PAYTECH_API_SECRET;
    if (!API_KEY || !API_SECRET) return res.status(500).json({ error: 'PayTech non configuré (clés Vercel manquantes)' });
    const ENV = (process.env.PAYTECH_ENV || 'test').toLowerCase() === 'prod' ? 'prod' : 'test';
    const BASE = (process.env.PUBLIC_BASE_URL || 'https://mgloot.com').replace(/\/+$/, '');

    getApp();

    // 1) Authentification Firebase
    const authHeader = req.headers.authorization || '';
    const m = String(authHeader).match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Non authentifié' });
    let uid, email = '';
    try { const d = await admin.auth().verifyIdToken(m[1]); uid = d.uid; email = d.email || ''; }
    catch (e) { return res.status(401).json({ error: 'Session invalide, reconnectez-vous.' }); }

    // 2) Montant + but
    let p = req.body; if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
    const amountEur = Math.round(((+p.amountEur || 0)) * 100) / 100;
    const purpose = (p.purpose || 'wallet').toString();       // 'wallet' | 'order'
    const orderId = (p.orderId || '').toString();
    if (amountEur < 0.5) return res.status(400).json({ error: 'Montant trop faible.' });
    if (purpose === 'order' && !orderId) return res.status(400).json({ error: 'Commande introuvable.' });
    const xof = Math.max(100, Math.round(amountEur * EUR_XOF)); // PayTech = FCFA (XOF)

    // 3) Référence unique + enregistrement "pending" (pour l'IPN)
    const refCommand = 'MGLOOT-' + uid.slice(0, 6) + '-' + Date.now();
    const db = admin.firestore();
    await db.collection('paytechPayments').doc(refCommand).set({
      uid, email, amountEur, xof, purpose, orderId: orderId || null, status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 4) Appel PayTech
    const params = {
      item_name: purpose === 'order' ? 'Commande LootR' : 'Recharge Portefeuille LootR',
      item_price: xof,
      currency: 'XOF',
      ref_command: refCommand,
      command_name: purpose === 'order' ? 'Commande LootR' : 'Recharge LootR',
      env: ENV,
      ipn_url: BASE + '/api/paytech-ipn',
      success_url: BASE + '/payment/success',
      cancel_url: BASE + '/payment/cancel',
      custom_field: JSON.stringify({ uid, amountEur, purpose, orderId: orderId || '', ref: refCommand })
    };

    const r = await fetch('https://paytech.sn/api/payment/request-payment', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'API_KEY': API_KEY,
        'API_SECRET': API_SECRET
      },
      body: JSON.stringify(params)
    });
    const data = await r.json().catch(() => ({}));

    // PayTech renvoie success=1 + token + redirect_url (ou redirectUrl)
    if (data && (data.success === 1 || data.success === true) && (data.redirect_url || data.redirectUrl)) {
      return res.status(200).json({ ok: true, redirect_url: data.redirect_url || data.redirectUrl, token: data.token || '' });
    }
    return res.status(200).json({ error: (data && (data.message || (data.errors && JSON.stringify(data.errors)))) || 'PayTech a refusé la demande.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
