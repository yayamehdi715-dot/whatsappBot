/**
 * 🌸 Tinkerbells — Bot WhatsApp E-commerce Cosmétiques Algérie
 * Utilise Baileys (WhatsApp Web) + OpenAI + MongoDB
 */

import pkg from '@whiskeysockets/baileys';
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers } = pkg;
import { Boom } from '@hapi/boom';
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
  return `Tu es Mina 🌸, la meilleure conseillère beauté de Tinkerbells, une marque de cosmétiques algérienne.

🌸 TA PERSONNALITÉ :
- Tu es ultra girly, solaire, chaleureuse, drôle et pétillante 💕✨
- Tu parles comme une vraie copine proche qui adore la beauté et le soin
- Tu utilises des emojis naturellement dans chaque message 🌸💄✨🥰💅🫶
- Tu complimentes toujours le client de façon sincère et spontanée
- Tu es enthousiaste, positive et bienveillante dans CHAQUE message
- Tu ne dis jamais non sèchement — tu proposes toujours une alternative
- Tu donnes envie d'acheter sans jamais forcer

🌍 LANGUES — RÈGLES STRICTES :
- Tu détectes AUTOMATIQUEMENT la langue du client dès son premier message
- Français → tu réponds en français 🇫🇷
- Anglais → tu réponds en anglais 🇬🇧
- Arabe classique (فصحى) → tu réponds en arabe classique 🇩🇿
- Espagnol → tu réponds en espagnol 🇪🇸
- Darija algérienne (واش راك، بغيت، كيما…) → tu COMPRENDS parfaitement et tu réponds en arabe classique دائماً
- Darija marocaine ou tunisienne → tu COMPRENDS et tu réponds en arabe classique
- Tu ne demandes JAMAIS au client dans quelle langue il veut parler — tu détectes et tu t'adaptes
- EXCEPTION UNIQUE : le formulaire de commande (prénom, nom, téléphone, wilaya, commune) est toujours demandé en français

🎤 MESSAGES VOCAUX :
- Si le client envoie un message vocal, tu reçois sa transcription en texte
- Tu traites ce texte exactement comme un message écrit normal
- Tu réponds dans la langue détectée dans la transcription

💬 STYLE DE CONVERSATION :
- Tes messages sont courts, dynamiques et chaleureux (3-5 lignes max)
- Tu poses UNE seule question à la fois
- Tu utilises le prénom du client si tu le connais
- Tu crées une vraie complicité de copine beauté

RÈGLE ABSOLUE : Tu réponds UNIQUEMENT en JSON valide. Format strict :
{
  "message": "ton message au client",
  "action": "CHAT" | "COMMANDER" | "DEMANDER_CONFIRMATION",
  "produit_nom": "nom exact du produit si action=COMMANDER ou DEMANDER_CONFIRMATION, sinon null",
  "produit_prix": prix en nombre si action=COMMANDER ou DEMANDER_CONFIRMATION, sinon null
}

═══ LOGIQUE DES ACTIONS ═══

"CHAT" → pour conseiller, poser des questions, présenter des produits.
  - Pour les soins cheveux : pose 1-2 questions avant de recommander
  - Pour la peau : demande le type de peau si pas mentionné
  - Mentionne TOUJOURS la marque ET le nom exact
  - Le client peut ajouter PLUSIEURS produits à sa commande

"DEMANDER_CONFIRMATION" → le client semble intéressé mais pas encore sûr.

"COMMANDER" → quand le client veut CLAIREMENT acheter un produit.
  - "je le veux", "je la veux", "j'achète", "je prends", "oui", "ok", "go", "wah", "bghitha"
  ⚠️ Si le client dit OUI après ta question de confirmation → COMMANDER obligatoire

═══ RÈGLES ABSOLUES ═══
- Ne propose QUE des produits du catalogue
- NE demande JAMAIS nom, prénom, téléphone, adresse — le système s'en charge
- NE fais JAMAIS de récapitulatif de commande

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
      model: 'gpt-4o-mini',
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

      await sendOptions(jid,
        `✨ Ajouté au panier !\n\n🛒 *Ton panier :*\n${formatPanier(session.panier)}\n\nTu veux ajouter autre chose ?`,
        [{ title: "Oui, j'ajoute" }, { title: 'Non, je finalise' }]
      );
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

async function handleAddMore(jid, userText, session) {
  const t = userText.toLowerCase();
  const yes = ['1', 'oui', 'ajoute', 'autre', 'yes', 'wah', 'bghit'].some(w => t.includes(w));
  const no  = ['2', 'non', 'finalise', 'no'].some(w => t.includes(w));

  let addMore = yes;

  if (!yes && !no) {
    try {
      const check = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Réponds uniquement en JSON: {"add_more": true} si le message indique que la personne veut ajouter autre chose, {"add_more": false} si elle veut finaliser.' },
          { role: 'user', content: userText },
        ],
        response_format: { type: 'json_object' },
      });
      addMore = JSON.parse(check.choices[0].message.content).add_more || false;
    } catch {}
  }

  if (addMore) {
    await sendText(jid, 'Super ! 🌸 Qu\'est-ce que tu veux ajouter ?');
    session.state = CHAT;
  } else {
    await sendText(jid, 'Parfait ! 📝 Ton prénom ? 👤');
    session.state = GET_PRENOM;
  }
}

async function handleGetPrenom(jid, userText, session) {
  session.prenom = userText.trim();
  await sendText(jid, 'Ton nom ? 👤');
  session.state = GET_NOM;
}

async function handleGetNom(jid, userText, session) {
  session.nom = userText.trim();
  await sendText(jid, 'Ton numéro de téléphone ? 📱');
  session.state = GET_PHONE;
}

async function handleGetPhone(jid, userText, session) {
  session.phoneClient = userText.trim();
  await sendText(jid, 'Ta wilaya ? 🗺️');
  session.state = GET_WILAYA;
}

async function handleGetWilaya(jid, userText, session) {
  session.wilaya = userText.trim();
  await sendText(jid, 'Ta commune ? 🏘️');
  session.state = GET_COMMUNE;
}

async function handleGetCommune(jid, userText, session) {
  session.commune = userText.trim();
  const { panier } = session;

  const recap =
    `📋 Récapitulatif de ta commande :\n\n` +
    `🛒 Produits :\n${formatPanier(panier)}\n\n` +
    `👤 Prénom : ${session.prenom}\n` +
    `👤 Nom : ${session.nom}\n` +
    `📱 Téléphone : ${session.phoneClient}\n` +
    `🗺️ Wilaya : ${session.wilaya}\n` +
    `🏘️ Commune : ${session.commune}`;

  await sendOptions(jid, recap, [{ title: '✅ CONFIRMER' }, { title: '❌ ANNULER' }]);
  session.state = CONFIRM_ORDER;
}

async function handleConfirmOrder(jid, phone, userText, session) {
  const t = userText.toLowerCase();
  const yes = ['1', 'confirmer', 'confirme', 'oui', 'yes', 'ok', 'wah'].some(w => t.includes(w));
  const no  = ['2', 'annuler', 'non', 'no'].some(w => t.includes(w));

  let confirmed = yes;

  if (!yes && !no) {
    try {
      const check = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Réponds uniquement en JSON: {"confirmed": true} si le message confirme une commande, {"confirmed": false} sinon.' },
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
        `👤 Prénom : ${session.prenom}\n👤 Nom : ${session.nom}\n` +
        `📱 Téléphone : ${session.phoneClient}\n` +
        `🗺️ Wilaya : ${session.wilaya}\n🏘️ Commune : ${session.commune}`;
      await sendText(ADMIN_PHONE + '@s.whatsapp.net', adminMsg);
    } catch (e) {
      console.error('Erreur notif admin:', e.message);
    }

    await sendText(jid,
      '🎉 Commande confirmée ! Merci pour ta confiance 🌸\n' +
      'Notre équipe te contactera très bientôt pour la livraison.\n\n' +
      'Tinkerbells — La beauté à votre portée ✨'
    );
  } else {
    await sendText(jid, '❌ Commande annulée. Tu peux continuer à magasiner 🌸');
  }

  await resetSession(phone);
}

// ─────────────────────────────────────────
// CONNEXION WHATSAPP AVEC BAILEYS
// ─────────────────────────────────────────
async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth:               state,
    browser:            Browsers.ubuntu('Tinkerbells Bot'),
    printQRInTerminal:  true,
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      console.log('📱 QR code disponible — ouvre la page web du bot pour le scanner');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : 0;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('❌ Connexion fermée (code', code, '). Reconnexion:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectWhatsApp, 5000);
      } else {
        console.log('🔑 Déconnecté. Supprime le dossier auth_info_baileys et redémarre.');
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
