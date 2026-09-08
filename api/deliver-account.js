// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/deliver-account
//
//  Le client NE PEUT PAS lire accounts/{id}/private/credentials
//  (règles Firestore) → d'où « Missing or insufficient permissions ».
//  Cette fonction serveur, elle, utilise firebase-admin qui ignore les
//  règles : elle vérifie que l'achat existe bien, puis renvoie les
//  identifiants à l'acheteur légitime uniquement.
//
//  POST { accountId, userId }
//  → { ok:true, login, password, notes }
//
//  ⚙️ FIREBASE_SERVICE_ACCOUNT requis sur Vercel.
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) {
    cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  }
  return admin.initializeApp({ credential: admin.credential.cert(cred) });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let p = req.body;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
  p = p || {};
  const accountId = String(p.accountId || '').trim();
  const userId    = String(p.userId || '').trim();
  if (!accountId || !userId) return res.status(400).json({ error: 'Paramètres manquants.' });

  try {
    getApp();
    const db = admin.firestore();

    // 1. L'achat doit exister et appartenir à ce client
    const pid = userId + '_' + accountId;
    const buy = await db.collection('accountPurchases').doc(pid).get();
    if (!buy.exists) return res.status(403).json({ error: 'Aucun achat trouvé pour ce compte.' });
    const b = buy.data() || {};
    if (b.userId !== userId) return res.status(403).json({ error: 'Achat non autorisé.' });
    if (b.status !== 'paid' && b.status !== 'delivered') {
      return res.status(403).json({ error: 'Paiement non confirmé.' });
    }

    // 2. Lecture des identifiants (interdite au client, autorisée ici)
    const cs = await db.collection('accounts').doc(accountId)
                       .collection('private').doc('credentials').get();
    if (!cs.exists) {
      return res.status(404).json({ error: "Identifiants pas encore renseignés. Le support vous les envoie sous peu." });
    }
    const c = cs.data() || {};

    // 3. Copie dans l'achat (le client pourra les relire dans son historique)
    await buy.ref.set({
      status: 'delivered',
      deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
      credentials: { login: c.login || '', password: c.password || '', notes: c.notes || '' }
    }, { merge: true });

    // 4. Le compte passe en « vendu » (le client n'a pas ce droit côté règles)
    await db.collection('accounts').doc(accountId).set({
      status: 'sold',
      soldTo: userId,
      soldAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true }).catch(() => {});

    // 5. 📧 Email des identifiants au client + 📲 push
    try {
      let email = b.email || '';
      let name = b.userName || '';
      if (!email) { try { const u = await db.collection('users').doc(userId).get(); const ud = u.data() || {}; email = ud.email || ''; name = name || ud.name || ''; } catch (e) {} }
      const title = (b.accountName || b.name || 'Votre compte') ;
      if (email) {
        const M = require('./_email.js');
        const html = M.wrap(
          '<h2 style="color:#e8c766;margin:0 0 10px">🎁 Votre compte est prêt</h2>'
          + '<p>Bonjour ' + (name || '') + ',</p>'
          + '<p>Voici les identifiants de votre achat : <b>' + title + '</b></p>'
          + '<div style="background:#141418;border-radius:10px;padding:14px;margin:12px 0;font-size:15px">'
          + '<b>Identifiant :</b> ' + (c.login || '—') + '<br>'
          + '<b>Mot de passe :</b> ' + (c.password || '—')
          + (c.notes ? ('<br><br><b>Notes :</b><br>' + String(c.notes).replace(/\n/g, '<br>')) : '')
          + '</div>'
          + '<p style="color:#ff9">⚠️ Changez le mot de passe dès votre première connexion, et ne partagez ces informations avec personne.</p>'
        );
        await M.sendEmail(email, '🎁 Identifiants de votre compte — MgLoot', html);
      }
      // Notification in-app + push
      await db.collection('users').doc(userId).collection('notifications').add({
        icon: '🎁', title: 'Compte livré', body: 'Les identifiants de « ' + title + ' » sont disponibles (et envoyés par email).',
        type: 'account', link: 'account', read: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
      try {
        const BASE = (process.env.PUBLIC_BASE_URL || 'https://mgloot.com').replace(/\/+$/, '');
        await fetch(BASE + '/api/send-push', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: userId, title: '🎁 Compte livré', body: 'Vos identifiants sont prêts.', url: '/' })
        });
      } catch (e) {}
    } catch (e) {}

    return res.status(200).json({
      ok: true,
      login: c.login || '',
      password: c.password || '',
      notes: c.notes || ''
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};
