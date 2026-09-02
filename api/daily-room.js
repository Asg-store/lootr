// ════════════════════════════════════════════════════════════════
//  LootR — /api/daily-room  (Fonction serverless Vercel, Node.js 18+)
//  Crée (ou récupère) une salle d'appel vidéo/vocal Daily.co et renvoie
//  son URL. La CLÉ SECRÈTE Daily.co reste UNIQUEMENT côté serveur.
//
//  Body attendu (POST JSON) :
//    { room?: string }   → nom logique de la salle (ex: "chat-<uid>")
//
//  ⚙️ Variable d'environnement REQUISE sur Vercel :
//    DAILY_API_KEY = votre clé API Daily.co (Dashboard Daily → Developers).
//    ⚠️ NE JAMAIS mettre cette clé dans le code client (index.html).
// ════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  // CORS simple (même origine en prod)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST uniquement' });

  const KEY = process.env.DAILY_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'DAILY_API_KEY manquant (variable d\'environnement Vercel)' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    // Nom de salle nettoyé (lettres, chiffres, - et _), 3 à 40 caractères
    let name = String(body.room || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    if (name.length < 3) name = 'lootr-' + Date.now();

    const headers = { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };

    // 1) La salle existe déjà ? → on renvoie son URL
    let r = await fetch('https://api.daily.co/v1/rooms/' + encodeURIComponent(name), { headers });
    if (r.status === 200) {
      const d = await r.json();
      return res.status(200).json({ url: d.url, name: d.name });
    }

    // 2) Sinon on la crée (expire dans 2 h)
    const exp = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
    r = await fetch('https://api.daily.co/v1/rooms', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name,
        privacy: 'public',
        properties: {
          exp,
          enable_screenshare: true,
          enable_chat: true,
          enable_knocking: false,
          start_video_off: false,
          start_audio_off: false
        }
      })
    });
    const d = await r.json();
    if (!r.ok) return res.status(500).json({ error: (d && (d.info || d.error)) || 'Création de la salle échouée' });
    return res.status(200).json({ url: d.url, name: d.name });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
