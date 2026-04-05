/**
 * 🌸 Tinkerbells — Bot WhatsApp E-commerce Cosmétiques Algérie
 * Utilise Baileys (WhatsApp Web) + OpenAI + MongoDB
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { MongoClient, ObjectId } from 'mongodb';
import OpenAI from 'openai';
import express from 'express';
import qrcode from 'qrcode';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_PHONE    = '33761179379';
const MONGO_URI      = 'mongodb+srv://merahlwos_db_user:CytBm67mupWzabhy@cluster0.lpbytcq.mongodb.net/?appName=Cluster0';

// États de conversation
const CHAT = 0, ADD_MORE = 1, GET_PRENOM = 2, GET_NOM = 3;
const GET_PHONE = 4, GET_WILAYA = 5, GET_COMMUNE = 6, CONFIRM_ORDER = 7;

// ─────────────────────────────────────────
// INITIALISATION
// ─────────────────────────────────────────
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const mongoClient = new MongoClient(MONGO_URI);
await mongoClient.connect();
const db          = mongoClient.db('test');
const productsCol = db.collection('products');
const ordersCol   = db.collection('orders');
console.log('✅ MongoDB connecté');

const sessions = {};
let sock       = null;
let currentQR  = null;

// ─────────────────────────────────────────
// SERVEUR HTTP (affichage du QR code)
// ─────────────────────────────────────────
const httpApp = express();
const PORT    = process.env.PORT || 3000;

httpApp.get('/', async (req, res) => {
  if (sock?.user) {
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h1>✅ Bot connecté !</h1>
        <p>Connecté en tant que : <b>${sock.user.name || sock.user.id}</b></p>
        <p>🌸 Tinkerbells Bot est opérationnel</p>
      </body></html>
    `);
  } else if (currentQR) {
    const img = await qrcode.toDataURL(currentQR);
    res.send(`
      <html><head><title>Tinkerbells — QR Code</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#fff0f5">
        <h1>🌸 Tinkerbells Bot</h1>
        <p>Ouvre WhatsApp → Appareils connectés → Connecter un appareil<br>
        Scanne ce QR code :</p>
        <img src="${img}" style="max-width:280px;border:4px solid #ff69b4;border-radius:12px"/>
        <p><small>Page rafraîchie automatiquement toutes les 20s</small></p>
        <script>setTimeout(() => location.reload(), 20000)</script>
      </body></html>
    `);
  } else {
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h1>⏳ Génération du QR code...</h1>
        <script>setTimeout(() => location.reload(), 3000)</script>
      </body></html>
    `);
  }
});

httpApp.listen(PORT, () => console.log(`✅ Serveur HTTP sur port ${PORT}`));

// ─────────────────────────────────────────
// CATALOGUE
// ─────────────────────────────────────────
async function fetchCatalog() {
  const products = await productsCol.find(
    { $or: [{ stock: { $gt: 0 } }, { 'sizes.stock': { $gt: 0 } }] },
    { projection: { name: 1, brand: 1, category: 1, price: 1, stock: 1, sizes: 1, description: 1 } }
  ).toArray();
  products.forEach(p => { p._id = p._id.toString(); });
  console.log(`✅ Catalogue : ${products.length} produits`);
  return products;
}

function formatCatalog(products) {
  const lines = [];
  for (const p of products) {
    const stock = (p.stock || 0) + (p.sizes || []).reduce((s, sz) => s + (sz.stock || 0), 0);
    if (stock <= 0) continue;
    const desc = p.description || {};
    const descText = desc.fr || desc.en || desc.ar || '';
    let line = `- NOM: ${p.name} | MARQUE: ${p.brand || ''} | CATÉGORIE: ${p.category || ''} | PRIX: ${p.price || '?'} DA`;
    if (descText) line += ` | DESC: ${descText}`;
    lines.push(line);
  }
  return lines.join('\n') || 'Aucun produit disponible.';
}

function findProduct(catalog, name) {
  const nameLower = name.toLowerCase().trim();
  for (const p of catalog) {
    if ((p.name || '').toLowerCase().trim() === nameLower) return p;
  }
  for (const p of catalog) {
    const pName = (p.name || '').toLowerCase();
    if (pName.includes(nameLower) || nameLower.includes(pName)) return p;
  }
  const words = new Set(nameLower.split(' '));
  let best = null, bestScore = 0;
  for (const p of catalog) {
    const pWords = new Set((p.name || '').toLowerCase().split(' '));
    const score  = [...words].filter(w => pWords.has(w)).length;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= 2 ? best : null;
}

function formatPanier(panier) {
  if (!panier.length) return 'Panier vide';
  const lines = [];
  let total = 0;
  for (const item of panier) {
    lines.push(`• ${item.nom} (${item.brand}) — ${item.prix} DA`);
    total += item.prix;
  }
  lines.push(`\n💰 Total : ${total} DA`);
  return lines.join('\n');
}

// ─────────────────────────────────────────
// PROMPT MINA
// ─────────────────────────────────────────
function buildSystemPrompt(products) {
  return `Tu es Mina 🌸, conseillère beauté de Tinkerbells — une boutique de cosmétiques algérienne.

🌸 QUI TU ES :
Tu es une vraie copine passionnée de beauté. Tu parles avec chaleur, naturel et bonne humeur. Tu n'es pas un robot vendeur — tu es quelqu'un qui aime vraiment aider et partager ses coups de cœur beauté. Chaque message que tu envoies doit donner envie de sourire 💕

✨ TON STYLE :
- Girly, pétillante, chaleureuse — comme une meilleure amie qui connaît tout en beauté
- Tu utilises des emojis de façon naturelle (pas excessif) : 🌸💄✨💅🥰💕
- Tes phrases sont courtes, vivantes, jamais robotiques
- Tu complimentes sincèrement, tu rassures, tu conseilles vraiment
- Tu n'es jamais pressée — tu prends le temps d'écouter et comprendre
- ⚠️ JAMAIS de Markdown : n'utilise JAMAIS * ** _ ` pour formater — le texte s'affiche brut sur WhatsApp

🛍️ COMMENT TU VENDS (TRÈS IMPORTANT) :
Tu ne proposes JAMAIS d'acheter directement. Tu suis toujours ce flow :

1. Tu écoutes ce que cherche le client
2. Tu poses des questions pour mieux comprendre (type de peau, cheveux, problème à résoudre...)
3. Tu présentes le produit comme une copine enthousiaste : ce qu'il fait, pourquoi il est bien, un détail qui fait la différence
4. TU ATTENDS que le client montre de l'intérêt avant d'aller plus loin
5. Seulement quand le client dit qu'il est intéressé → tu demandes : "Tu veux que je l'ajoute à ton panier ? 🛒" ou "Tu veux plus d'infos ou je te l'ajoute ? 💕"
6. Seulement quand le client confirme vouloir l'acheter → action COMMANDER

🌍 LANGUES :
- Détecte automatiquement la langue du client
- Français → réponds en français
- Anglais → réponds en anglais
- Arabe classique → réponds en arabe classique
- Espagnol → réponds en espagnol
- Darija (algérienne, marocaine, tunisienne) → comprends et réponds en arabe classique
- Ne demande JAMAIS dans quelle langue parler
- EXCEPTION : le formulaire de commande est toujours en français

🎤 MESSAGES VOCAUX :
Tu reçois la transcription en texte — traite-la comme un message normal.

RÈGLE ABSOLUE : Tu réponds UNIQUEMENT en JSON valide. Format strict :
{
  "message": "ton message au client",
  "action": "CHAT" | "COMMANDER" | "DEMANDER_CONFIRMATION",
  "produit_nom": "nom exact du produit si action=COMMANDER ou DEMANDER_CONFIRMATION, sinon null",
  "produit_prix": prix en nombre si action=COMMANDER ou DEMANDER_CONFIRMATION, sinon null
}

═══ LOGIQUE DES ACTIONS ═══

"CHAT" → par défaut. Pour discuter, conseiller, présenter un produit, poser des questions, expliquer les bénéfices. N'utilise pas DEMANDER_CONFIRMATION ou COMMANDER avant que le client ait vraiment montré qu'il veut acheter.

"DEMANDER_CONFIRMATION" → le client a montré de l'intérêt (ex: "ça a l'air bien", "c'est quoi le prix", "je veux essayer"). Tu lui demandes alors gentiment s'il veut l'ajouter au panier.

"COMMANDER" → le client confirme clairement vouloir acheter ("oui", "ajoute-le", "je le prends", "wah", "bghitha", "ok go").

═══ RÈGLES ABSOLUES ═══
- Ne propose QUE des produits du catalogue
- NE demande JAMAIS nom, prénom, téléphone, adresse — le système s'en charge
- NE fais JAMAIS de récapitulatif de commande
- Ne force jamais la vente — laisse le client venir à toi naturellement

🌸 Catalogue :
${formatCatalog(products)}`;
}

// ─────────────────────────────────────────
// SESSIONS
// ─────────────────────────────────────────
async function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = {
      state:           CHAT,
      catalog:         await fetchCatalog(),
      history:         [],
      panier:          [],
      produitEnAttente: null,
      prenom: '', nom: '', phoneClient: '', wilaya: '', commune: '',
    };
  }
  return sessions[phone];
}

async function resetSession(phone) {
  sessions[phone] = {
    state:           CHAT,
    catalog:         await fetchCatalog(),
    history:         [],
    panier:          [],
    produitEnAttente: null,
    prenom: '', nom: '', phoneClient: '', wilaya: '', commune: '',
  };
}

// ─────────────────────────────────────────
// TRANSCRIPTION AUDIO (Whisper)
// ─────────────────────────────────────────
async function transcribeAudio(msg) {
  try {
    const buffer  = await downloadMediaMessage(msg, 'buffer', {});
    const tmpPath = path.join(os.tmpdir(), `audio_${Date.now()}.ogg`);
    fs.writeFileSync(tmpPath, buffer);
    const transcript = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file:  fs.createReadStream(tmpPath),
    });
    fs.unlinkSync(tmpPath);
    return transcript.text;
  } catch (e) {
    console.error('Erreur transcription:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────
// PARSE RÉPONSE IA
// ─────────────────────────────────────────
function parseAiResponse(raw) {
  let clean = raw.trim();
  if (clean.startsWith('```')) {
    const parts = clean.split('```');
    clean = parts[1] || parts[0];
    if (clean.startsWith('json')) clean = clean.slice(4);
  }
  clean = clean.trim();
  try {
    return JSON.parse(clean);
  } catch {
    const msgMatch  = clean.match(/"message"\s*:\s*"(.*?)"(?=\s*,\s*"action")/s);
    const actMatch  = clean.match(/"action"\s*:\s*"(\w+)"/);
    const nomMatch  = clean.match(/"produit_nom"\s*:\s*"(.*?)"/);
    const prixMatch = clean.match(/"produit_prix"\s*:\s*([0-9.]+)/);
    return {
      message:      msgMatch  ? msgMatch[1]              : "Je suis là pour t'aider 🌸",
      action:       actMatch  ? actMatch[1]               : 'CHAT',
      produit_nom:  nomMatch  ? nomMatch[1]               : null,
      produit_prix: prixMatch ? parseFloat(prixMatch[1]) : null,
    };
  }
}

// ─────────────────────────────────────────
// HELPERS D'ENVOI
// ─────────────────────────────────────────
async function sendText(jid, text) {
  try {
    await sock.sendMessage(jid, { text });
  } catch (e) {
    console.error('Erreur sendText:', e.message);
  }
}

async function sendOptions(jid, body, options) {
  const text = body + '\n\n' + options.map((o, i) => `${i + 1}️⃣  ${o.title}`).join('\n');
  await sendText(jid, text);
}

// ─────────────────────────────────────────
// HANDLERS PAR ÉTAT
// ─────────────────────────────────────────
async function handleChat(jid, phone, userText, session) {
  const { catalog, history } = session;
  history.push({ role: 'user', content: userText });

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: buildSystemPrompt(catalog) },
        ...history.slice(-20),
      ],
      response_format: { type: 'json_object' },
    });
    const raw  = response.choices[0].message.content;
    const data = parseAiResponse(raw);

    let { message, action, produit_nom, produit_prix } = data;

    if (action === 'DEMANDER_CONFIRMATION' && session.produitEnAttente && produit_nom) {
      action = 'COMMANDER';
    }

    history.push({ role: 'assistant', content: raw });

    await sendText(jid, message);

    if (action === 'COMMANDER' && produit_nom) {
      const produit = findProduct(catalog, produit_nom);
      const item = produit
        ? { id: produit._id, nom: produit.name, brand: produit.brand || '', prix: produit.price || produit_prix || 0 }
        : { id: null, nom: produit_nom, brand: '', prix: produit_prix || 0 };

      session.panier.push(item);
      session.produitEnAttente = null;
      console.log(`🛒 Panier ${phone}:`, session.panier.map(p => p.nom));

      const panierTxt = formatPanier(session.panier);
      const addMsg = await minaAsk(jid, session,
        `${item.nom} vient d'être ajouté au panier ! Le panier actuel :\n${panierTxt}\nDemande si elle veut ajouter autre chose ou passer à la commande. Sois enthousiaste !`
      );
      await sendText(jid, addMsg || `✨ Ajouté au panier !\n\n🛒 Ton panier :\n${panierTxt}\n\nTu veux ajouter autre chose ou on passe à la commande ? 💕`);
      session.state = ADD_MORE;

    } else if (action === 'DEMANDER_CONFIRMATION' && produit_nom) {
      const produit = findProduct(catalog, produit_nom);
      if (produit) {
        session.produitEnAttente = {
          id: produit._id, nom: produit.name,
          brand: produit.brand || '', prix: produit.price || produit_prix || 0,
        };
      }
    }

  } catch (e) {
    console.error('Erreur chat:', e.message);
    await sendText(jid, "⚠️ Une erreur s'est produite, réessaie.");
  }
}

// Helper : Mina génère un message naturel selon une instruction
async function minaAsk(jid, session, instruction) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content:
            `Tu es Mina 🌸, conseillère beauté girly et chaleureuse de Tinkerbells (boutique algérienne). ` +
            `Tu parles comme une vraie copine. Tu utilises des emojis avec naturel. ` +
            `Génère UN message court et naturel selon l'instruction. ` +
            `RÈGLES ABSOLUES :\n` +
            `- N'utilise JAMAIS de Markdown : interdit * ** _ \` — le texte s'affiche brut sur WhatsApp\n` +
            `- Si tu demandes une info, précise toujours gentiment d'écrire à la main (pas de vocal)\n` +
            `- Pour l'adresse de livraison : demande TOUJOURS "wilaya" puis "commune" — jamais "région" ou "adresse"\n` +
            `- Réponds UNIQUEMENT avec le texte du message, rien d'autre`,
        },
        ...session.history.slice(-10),
        { role: 'user', content: `[INSTRUCTION INTERNE] ${instruction}` },
      ],
    });
    return res.choices[0].message.content.trim();
  } catch {
    return null;
  }
}

function isValidPhone(phone) {
  // Accepte formats algériens (05/06/07...) et français (+33/0033/06/07)
  const cleaned = phone.replace(/[\s.\-()]/g, '');
  return /^(\+?213|0)(5|6|7)\d{8}$/.test(cleaned) ||
         /^(\+?33|0)(6|7)\d{8}$/.test(cleaned) ||
         /^\d{9,15}$/.test(cleaned);
}

async function handleAddMore(jid, userText, session) {
  const t = userText.toLowerCase();
  const yes = ['1', 'oui', 'ajoute', 'autre', 'yes', 'wah', 'bghit'].some(w => t.includes(w));
  const no  = ['2', 'non', 'finalise', 'commander', 'passer', 'caisse'].some(w => t.includes(w));

  let addMore = yes;

  if (!yes && !no) {
    try {
      const check = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Réponds uniquement en JSON: {"add_more": true} si la personne veut ajouter autre chose, {"add_more": false} si elle veut finaliser/commander.' },
          { role: 'user', content: userText },
        ],
        response_format: { type: 'json_object' },
      });
      addMore = JSON.parse(check.choices[0].message.content).add_more || false;
    } catch {}
  }

  if (addMore) {
    const msg = await minaAsk(jid, session, 'La cliente veut ajouter autre chose à son panier. Demande-lui ce qu\'elle veut ajouter.');
    await sendText(jid, msg || 'Super ! 🌸 Dis-moi ce que tu veux ajouter !');
    session.state = CHAT;
  } else {
    const msg = await minaAsk(jid, session, 'La cliente veut finaliser sa commande. Dis-lui que tu vas avoir besoin de quelques infos pour la livraison, et commence par demander son prénom — en précisant d\'écrire à la main (pas de vocal).');
    await sendText(jid, msg || 'Super ! 🌸 Pour la livraison, j\'ai besoin de quelques infos ✍️\nCommence par me donner ton prénom (écris à la main stp, pas de vocal pour les infos) 👤');
    session.state = GET_PRENOM;
  }
}

async function handleGetPrenom(jid, userText, session) {
  if (!userText.trim() || userText.trim().length < 2) {
    const msg = await minaAsk(jid, session, 'La cliente n\'a pas donné un prénom valide. Redemande-lui son prénom gentiment, en précisant d\'écrire à la main.');
    await sendText(jid, msg || 'Oops 🌸 Tu peux m\'écrire ton prénom ? (juste le texte, pas de vocal stp)');
    return;
  }
  session.prenom = userText.trim();
  const msg = await minaAsk(jid, session, `La cliente s'appelle ${session.prenom}. Utilise son prénom et demande-lui son nom de famille maintenant — rappelle d'écrire à la main.`);
  await sendText(jid, msg || `Merci ${session.prenom} 💕 Et ton nom de famille ? (en texte stp) 👤`);
  session.state = GET_NOM;
}

async function handleGetNom(jid, userText, session) {
  if (!userText.trim() || userText.trim().length < 2) {
    const msg = await minaAsk(jid, session, 'La cliente n\'a pas donné un nom valide. Redemande gentiment son nom de famille, en précisant d\'écrire à la main.');
    await sendText(jid, msg || 'Je n\'ai pas bien saisi ton nom 🌸 Tu peux me l\'écrire ? (pas de vocal stp)');
    return;
  }
  session.nom = userText.trim();
  const msg = await minaAsk(jid, session, `Nom enregistré : ${session.nom}. Demande maintenant son numéro de téléphone pour la livraison — rappelle d'écrire à la main et donne un exemple de format (ex: 0612345678).`);
  await sendText(jid, msg || 'Super ! 📱 Ton numéro de téléphone maintenant ? (écris-le en chiffres stp, ex: 0612345678)');
  session.state = GET_PHONE;
}

async function handleGetPhone(jid, userText, session) {
  const num = userText.trim();
  if (!isValidPhone(num)) {
    const msg = await minaAsk(jid, session, `La cliente a entré "${num}" comme numéro de téléphone mais ce n'est pas un numéro valide. Explique-lui gentiment et redemande un numéro correct (ex: 0612345678 ou 0555123456), en rappelant d'écrire à la main.`);
    await sendText(jid, msg || `Hmm ce numéro ne semble pas correct 🌸 Tu peux me redonner ton numéro de téléphone ? (ex: 0612345678)`);
    return;
  }
  session.phoneClient = num;
  const msg = await minaAsk(jid, session, 'Numéro de téléphone enregistré. Demande maintenant sa wilaya (ville/région) pour la livraison — rappelle d\'écrire à la main.');
  await sendText(jid, msg || 'Parfait ! 🗺️ Ta wilaya ? (écris-la stp, pas de vocal)');
  session.state = GET_WILAYA;
}

async function handleGetWilaya(jid, userText, session) {
  if (!userText.trim() || userText.trim().length < 2) {
    const msg = await minaAsk(jid, session, 'La cliente n\'a pas donné une wilaya valide. Redemande gentiment.');
    await sendText(jid, msg || 'Je n\'ai pas bien saisi ta wilaya 🌸 Tu peux me l\'écrire ?');
    return;
  }
  session.wilaya = userText.trim();
  const msg = await minaAsk(jid, session, `Wilaya : ${session.wilaya}. Demande maintenant sa commune (quartier/ville précise) — rappelle d'écrire à la main.`);
  await sendText(jid, msg || 'Et ta commune ? 🏘️ (en texte stp)');
  session.state = GET_COMMUNE;
}

async function handleGetCommune(jid, userText, session) {
  if (!userText.trim() || userText.trim().length < 2) {
    const msg = await minaAsk(jid, session, 'La cliente n\'a pas donné une commune valide. Redemande gentiment.');
    await sendText(jid, msg || 'Tu peux me préciser ta commune ? 🌸 (en texte stp)');
    return;
  }
  session.commune = userText.trim();
  const { panier } = session;
  const total = panier.reduce((s, i) => s + i.prix, 0);

  // Recap produits
  const produitsTxt = panier.map(i => `• ${i.nom} (${i.brand}) — ${i.prix} DA`).join('\n');

  const recapData =
    `🛒 Commande :\n${produitsTxt}\n💰 Total : ${total} DA\n\n` +
    `👤 Prénom : ${session.prenom}\n` +
    `👤 Nom : ${session.nom}\n` +
    `📱 Téléphone : ${session.phoneClient}\n` +
    `🗺️ Wilaya : ${session.wilaya}\n` +
    `🏘️ Commune : ${session.commune}`;

  const msg = await minaAsk(jid, session,
    `Toutes les infos sont collectées. Fais un récapitulatif complet et chaleureux de la commande avec ces données :\n${recapData}\n\nEnsuite demande si tout est correct et si elle veut confirmer sa commande. Sois naturelle et enthousiaste !`
  );
  await sendText(jid, msg ||
    `📋 Voici le récap de ta commande :\n\n${recapData}\n\nTout est correct ? Tu confirmes ta commande ? 🌸`
  );
  session.state = CONFIRM_ORDER;
}

async function handleConfirmOrder(jid, phone, userText, session) {
  const t = userText.toLowerCase();
  const yes = ['confirmer', 'confirme', 'oui', 'yes', 'ok', 'wah', 'c bon', 'correct', 'parfait', 'go'].some(w => t.includes(w));
  const no  = ['annuler', 'annule', 'non', 'no', 'pas', 'arrête', 'stop'].some(w => t.includes(w));

  let confirmed = yes;

  if (!yes && !no) {
    try {
      const check = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Réponds uniquement en JSON: {"confirmed": true} si le message confirme une commande, {"confirmed": false} si elle annule ou hésite.' },
          { role: 'user', content: userText },
        ],
        response_format: { type: 'json_object' },
      });
      confirmed = JSON.parse(check.choices[0].message.content).confirmed || false;
    } catch {}
  }

  const { panier } = session;

  if (confirmed && panier.length) {
    const total    = panier.reduce((s, i) => s + i.prix, 0);
    const itemsDoc = panier.map(item => ({
      product:  item.id ? new ObjectId(item.id) : null,
      name:     item.nom,
      quantity: 1,
      price:    item.prix,
    }));

    try {
      await ordersCol.insertOne({
        customerInfo: {
          firstName: session.prenom,
          lastName:  session.nom,
          phone:     session.phoneClient,
          wilaya:    session.wilaya,
          commune:   session.commune,
        },
        items: itemsDoc, total,
        deliveryFee: 0, deliveryType: 'home', deliverySpeed: 'express',
        status: 'en attente', source: 'whatsapp',
        createdAt: new Date(), updatedAt: new Date(),
      });
      console.log(`✅ Commande sauvegardée pour ${phone}`);
    } catch (e) {
      console.error('Erreur MongoDB:', e.message);
    }

    try {
      const now      = new Date().toLocaleString('fr-FR');
      const itemsTxt = panier.map(i => `  • ${i.nom} — ${i.prix} DA`).join('\n');
      const adminMsg =
        `🛍️ NOUVELLE COMMANDE TINKERBELLS\n📅 ${now}\n\n` +
        `🛒 Produits :\n${itemsTxt}\n💰 Total : ${total} DA\n\n` +
        `👤 ${session.prenom} ${session.nom}\n` +
        `📱 ${session.phoneClient}\n` +
        `🗺️ ${session.wilaya} — ${session.commune}`;
      await sendText(ADMIN_PHONE + '@s.whatsapp.net', adminMsg);
    } catch (e) {
      console.error('Erreur notif admin:', e.message);
    }

    const msg = await minaAsk(jid, session,
      `La commande est confirmée et enregistrée ! Envoie un message de confirmation chaleureux et girly à ${session.prenom}, dis-lui que l'équipe va la contacter bientôt pour la livraison. Sois enthousiaste et sincère !`
    );
    await sendText(jid, msg ||
      `🎉 Commande confirmée ${session.prenom} ! Merci pour ta confiance 🌸\nNotre équipe te contactera très bientôt pour la livraison.\n\nTinkerbells — La beauté à votre portée ✨`
    );
  } else {
    const msg = await minaAsk(jid, session,
      'La cliente a annulé sa commande. Réagis avec compréhension, dis-lui que c\'est pas grave et qu\'elle peut revenir quand elle veut. Reste chaleureuse.'
    );
    await sendText(jid, msg || 'Pas de souci du tout 🌸 Ta commande est annulée. N\'hésite pas à revenir quand tu veux, je suis là 💕');
  }

  await resetSession(phone);
}

// ─────────────────────────────────────────
// CONNEXION WHATSAPP AVEC BAILEYS
// ─────────────────────────────────────────
async function connectWhatsApp() {
  // Récupérer la version WA la plus récente
  const { version } = await fetchLatestBaileysVersion();
  console.log(`📱 Version WhatsApp Web: ${version.join('.')}`);

  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    version,
    auth:                           state,
    browser:                        Browsers.ubuntu('Chrome'),
    printQRInTerminal:              true,
    logger:                         pino({ level: 'silent' }),
    syncFullHistory:                false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs:               60000,
    defaultQueryTimeoutMs:          60000,
    keepAliveIntervalMs:            30000,
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      console.log('📱 QR code disponible — ouvre http://localhost:3000 pour le scanner');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : 0;
      console.log('❌ Connexion fermée (code', code, ')');

      if (code === 405) {
        // Session corrompue — on efface et on recrée
        console.log('🗑️ Session corrompue, suppression et reconnexion...');
        fs.rmSync('auth_info_baileys', { recursive: true, force: true });
        setTimeout(connectWhatsApp, 3000);
      } else if (code === DisconnectReason.loggedOut || code === 401) {
        console.log('🔑 Déconnecté. Suppression de la session...');
        fs.rmSync('auth_info_baileys', { recursive: true, force: true });
        setTimeout(connectWhatsApp, 3000);
      } else {
        setTimeout(connectWhatsApp, 5000);
      }
    } else if (connection === 'open') {
      currentQR = null;
      console.log('✅ WhatsApp connecté !', sock.user?.name || '');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith('@g.us')) continue; // ignorer les groupes

        const phone   = jid.split('@')[0];
        const content = msg.message;
        if (!content) continue;

        let userText = null;

        if (content.conversation) {
          userText = content.conversation;
        } else if (content.extendedTextMessage?.text) {
          userText = content.extendedTextMessage.text;
        } else if (content.audioMessage || content.pttMessage) {
          console.log(`🎤 Message vocal de ${phone}`);
          userText = await transcribeAudio(msg);
          if (!userText) {
            await sendText(jid, 'Désolée, je n\'ai pas pu comprendre ton message vocal 🌸 Tu peux réessayer ou écrire en texte ?');
            continue;
          }
          console.log(`🎤 Transcription: ${userText}`);
        } else {
          await sendText(jid, 'Je comprends les messages texte et vocaux 🌸');
          continue;
        }

        // Message de démarrage
        const greetings = ['bonjour', 'salut', 'hi', 'hello', 'start', 'مرحبا', 'ahlan'];
        if (greetings.includes(userText.toLowerCase().trim())) {
          await resetSession(phone);
          await sendText(jid,
            '🌸 Bienvenue chez Tinkerbells !\n\nJe suis Mina, votre conseillère beauté 💄\nComment puis-je vous aider ?'
          );
          continue;
        }

        const session  = await getSession(phone);
        const { state } = session;

        if      (state === CHAT)          await handleChat(jid, phone, userText, session);
        else if (state === ADD_MORE)      await handleAddMore(jid, userText, session);
        else if (state === GET_PRENOM)    await handleGetPrenom(jid, userText, session);
        else if (state === GET_NOM)       await handleGetNom(jid, userText, session);
        else if (state === GET_PHONE)     await handleGetPhone(jid, userText, session);
        else if (state === GET_WILAYA)    await handleGetWilaya(jid, userText, session);
        else if (state === GET_COMMUNE)   await handleGetCommune(jid, userText, session);
        else if (state === CONFIRM_ORDER) await handleConfirmOrder(jid, phone, userText, session);
        else                              await handleChat(jid, phone, userText, session);

      } catch (e) {
        console.error('Erreur traitement message:', e.message);
      }
    }
  });
}

connectWhatsApp().catch(console.error);