"""
🌸 Tinkerbells — Bot WhatsApp E-commerce Cosmétiques Algérie
=============================================================
Installation : pip install flask openai pymongo requests
"""

import os
import logging
import json
import re
import requests
import tempfile
from flask import Flask, request, jsonify
from bson import ObjectId
from openai import OpenAI
from pymongo import MongoClient
from datetime import datetime

# ─────────────────────────────────────────
# 🔧 CONFIGURATION
# ─────────────────────────────────────────
OPENAI_API_KEY   = os.environ.get("OPENAI_API_KEY")
WHATSAPP_TOKEN   = "EAALGmSRN1qYBRCuL1S8VzKxJh9b5aqNDtsoBRacfFVsmZAnfr1ceOg3w4MdPT4MFMKorB4ZBmOyyeJh3M1sFf3BEUIDmIwZC15gt3clJm3QrQIMBHLZC19XwZCTd1OU4WTH5aQVQXEZB5zzZA8eT4QuEwk8zPvSmUZCPE0D88AuLPv4DFxpwPCpRJIBue6VlXWWPEiAVZB5RhfeHADbLMzo2RGP8wgswMam5t2ThhZC7rCZCqcbZCNfKxbFssEzStcjuWepLhrG5VlXYjEG8gV4BYvEp"
PHONE_NUMBER_ID  = "1086279481229668"
VERIFY_TOKEN     = "tinkerbells_secret"
ADMIN_PHONE      = "213761179379"
MONGO_URI        = "mongodb+srv://merahlwos_db_user:CytBm67mupWzabhy@cluster0.lpbytcq.mongodb.net/?appName=Cluster0"

WA_API_URL = f"https://graph.facebook.com/v19.0/{PHONE_NUMBER_ID}/messages"
WA_HEADERS = {
    "Authorization": f"Bearer {WHATSAPP_TOKEN}",
    "Content-Type": "application/json",
}

# États de la conversation
CHAT, ADD_MORE, GET_PRENOM, GET_NOM, GET_PHONE, GET_WILAYA, GET_COMMUNE, CONFIRM_ORDER = range(8)

# ─────────────────────────────────────────
# 🚀 INITIALISATION
# ─────────────────────────────────────────

logging.basicConfig(format="%(asctime)s - %(levelname)s - %(message)s", level=logging.INFO)
logger = logging.getLogger(__name__)

app          = Flask(__name__)
ai_client    = OpenAI(api_key=OPENAI_API_KEY)
mongo        = MongoClient(MONGO_URI)
db           = mongo["test"]
products_col = db["products"]
orders_col   = db["orders"]

# Sessions en mémoire : { phone_number: { state, catalog, history, panier, ... } }
sessions = {}

# ─────────────────────────────────────────
# 📤 ENVOI DE MESSAGES WHATSAPP
# ─────────────────────────────────────────

def send_text(to: str, text: str):
    """Envoie un message texte simple."""
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": {"body": text}
    }
    r = requests.post(WA_API_URL, headers=WA_HEADERS, json=payload)
    if r.status_code != 200:
        logger.error(f"Erreur envoi message: {r.text}")

def send_buttons(to: str, body: str, buttons: list):
    """
    Envoie un message avec boutons interactifs (max 3).
    buttons = [{"id": "btn_1", "title": "Oui"}, ...]
    """
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "interactive",
        "interactive": {
            "type": "button",
            "body": {"text": body},
            "action": {
                "buttons": [
                    {"type": "reply", "reply": {"id": b["id"], "title": b["title"]}}
                    for b in buttons
                ]
            }
        }
    }
    r = requests.post(WA_API_URL, headers=WA_HEADERS, json=payload)
    if r.status_code != 200:
        logger.error(f"Erreur envoi boutons: {r.text}")

# ─────────────────────────────────────────
# 🎤 TRANSCRIPTION VOCALE (WHISPER)
# ─────────────────────────────────────────

def transcribe_audio(media_id: str) -> str | None:
    """Télécharge un message vocal WhatsApp et le transcrit avec Whisper."""
    try:
        # 1. Récupérer l'URL du fichier audio
        meta_url = f"https://graph.facebook.com/v19.0/{media_id}"
        r = requests.get(meta_url, headers=WA_HEADERS)
        if r.status_code != 200:
            logger.error(f"Erreur récupération media: {r.text}")
            return None
        audio_url = r.json().get("url")

        # 2. Télécharger le fichier audio
        r2 = requests.get(audio_url, headers=WA_HEADERS)
        if r2.status_code != 200:
            logger.error("Erreur téléchargement audio")
            return None

        # 3. Sauvegarder temporairement et transcrire avec Whisper
        with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as tmp:
            tmp.write(r2.content)
            tmp_path = tmp.name

        with open(tmp_path, "rb") as audio_file:
            transcript = ai_client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
            )
        os.unlink(tmp_path)
        return transcript.text

    except Exception as e:
        logger.error(f"Erreur transcription: {e}")
        return None

# ─────────────────────────────────────────
# 🛍️ CATALOGUE
# ─────────────────────────────────────────

def fetch_catalog() -> list:
    products = list(products_col.find(
        {"$or": [{"stock": {"$gt": 0}}, {"sizes.stock": {"$gt": 0}}]},
        {"name": 1, "brand": 1, "category": 1, "price": 1, "stock": 1, "sizes": 1, "description": 1}
    ))
    for p in products:
        p["_id"] = str(p["_id"])
    logger.info(f"✅ Catalogue : {len(products)} produits")
    return products

def format_catalog(products: list) -> str:
    lines = []
    for p in products:
        stock = p.get("stock", 0) + sum(s.get("stock", 0) for s in p.get("sizes", []))
        if stock <= 0:
            continue
        desc = (p.get("description") or {})
        desc_text = desc.get("fr") or desc.get("en") or desc.get("ar") or ""
        line = f"- NOM: {p['name']} | MARQUE: {p.get('brand','')} | CATÉGORIE: {p.get('category','')} | PRIX: {p.get('price','?')} DA"
        if desc_text:
            line += f" | DESC: {desc_text}"
        lines.append(line)
    return "\n".join(lines) or "Aucun produit disponible."

def find_product(catalog: list, name: str) -> dict | None:
    name_l = name.lower().strip()
    for p in catalog:
        if p.get("name", "").lower().strip() == name_l:
            return p
    for p in catalog:
        if name_l in p.get("name", "").lower() or p.get("name", "").lower() in name_l:
            return p
    words = set(name_l.split())
    best, best_score = None, 0
    for p in catalog:
        score = len(words & set(p.get("name", "").lower().split()))
        if score > best_score:
            best_score, best = score, p
    return best if best_score >= 2 else None

def format_panier(panier: list) -> str:
    if not panier:
        return "Panier vide"
    lines = []
    total = 0
    for item in panier:
        lines.append(f"• {item['nom']} ({item['brand']}) — {item['prix']} DA")
        total += item['prix']
    lines.append(f"\n💰 Total : {total} DA")
    return "\n".join(lines)

# ─────────────────────────────────────────
# 🤖 PROMPT DEEPSEEK
# ─────────────────────────────────────────

def build_system_prompt(products: list) -> str:
    return f"""Tu es Mina 🌸, conseillère beauté de Tinkerbells, une marque de cosmétiques algérienne.

Ta personnalité :
- Tu es ultra girly, douce, chaleureuse et pétillante 💕✨
- Tu parles comme une vraie copine algérienne qui adore la beauté
- Tu utilises des emojis avec naturel 🌸💄✨🥰💅
- Tu complimentes toujours le client sincèrement
- Tu détectes automatiquement la langue du client et tu réponds TOUJOURS dans la même langue
- Si le client écrit en arabe classique → tu réponds en arabe classique
- Si le client écrit en français → tu réponds en français
- Si le client écrit en anglais → tu réponds en anglais
- Si le client écrit en darija et que tu n'es pas sûre de comprendre, réponds :
  "Désolée ma belle, je comprends mieux le français, l'anglais ou l'arabe classique 😊 Tu préfères quelle langue ? 🌸"
- EXCEPTION : le formulaire (prénom, nom, téléphone, wilaya, commune) est TOUJOURS en français
- Tu es enthousiaste et positive dans CHAQUE message

RÈGLE ABSOLUE : Tu réponds UNIQUEMENT en JSON valide. Format strict :
{{
  "message": "ton message au client",
  "action": "CHAT" | "COMMANDER" | "DEMANDER_CONFIRMATION",
  "produit_nom": "nom exact du produit si action=COMMANDER ou DEMANDER_CONFIRMATION, sinon null",
  "produit_prix": prix en nombre si action=COMMANDER ou DEMANDER_CONFIRMATION, sinon null
}}

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
{format_catalog(products)}
"""

# ─────────────────────────────────────────
# 🔄 GESTION DES SESSIONS
# ─────────────────────────────────────────

def get_session(phone: str) -> dict:
    if phone not in sessions:
        sessions[phone] = {
            "state":              CHAT,
            "catalog":            fetch_catalog(),
            "history":            [],
            "panier":             [],
            "produit_en_attente": None,
            "prenom": "", "nom": "", "phone_client": "", "wilaya": "", "commune": "",
        }
    return sessions[phone]

def reset_session(phone: str):
    sessions[phone] = {
        "state":              CHAT,
        "catalog":            fetch_catalog(),
        "history":            [],
        "panier":             [],
        "produit_en_attente": None,
        "prenom": "", "nom": "", "phone_client": "", "wilaya": "", "commune": "",
    }

# ─────────────────────────────────────────
# 🧠 PARSING RÉPONSE IA
# ─────────────────────────────────────────

def parse_ai_response(raw: str) -> dict:
    clean = raw.strip()
    if clean.startswith("```"):
        clean = clean.split("```")[1]
        if clean.startswith("json"):
            clean = clean[4:]
    clean = clean.strip()
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        message_match = re.search(r'"message"\s*:\s*"(.*?)"(?=\s*,\s*"action")', clean, re.DOTALL)
        action_match  = re.search(r'"action"\s*:\s*"(\w+)"', clean)
        nom_match     = re.search(r'"produit_nom"\s*:\s*"(.*?)"', clean)
        prix_match    = re.search(r'"produit_prix"\s*:\s*([0-9.]+)', clean)
        return {
            "message":      message_match.group(1) if message_match else "Je suis là pour t'aider 🌸",
            "action":       action_match.group(1)  if action_match  else "CHAT",
            "produit_nom":  nom_match.group(1)     if nom_match     else None,
            "produit_prix": float(prix_match.group(1)) if prix_match else None,
        }

# ─────────────────────────────────────────
# 💬 HANDLERS PAR ÉTAT
# ─────────────────────────────────────────

def handle_chat(phone: str, user_text: str, session: dict):
    catalog = session["catalog"]
    history = session["history"]
    history.append({"role": "user", "content": user_text})

    try:
        response = ai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": build_system_prompt(catalog)},
                *history[-20:]
            ],
            response_format={"type": "json_object"}
        )
        raw  = response.choices[0].message.content
        data = parse_ai_response(raw)

        message   = data.get("message", "")
        action    = data.get("action", "CHAT")
        prod_nom  = data.get("produit_nom")
        prod_prix = data.get("produit_prix")

        if action == "DEMANDER_CONFIRMATION" and session.get("produit_en_attente") and prod_nom:
            action = "COMMANDER"

        history.append({"role": "assistant", "content": raw})
        session["history"] = history

        send_text(phone, message)

        if action == "COMMANDER" and prod_nom:
            produit = find_product(catalog, prod_nom)
            if produit:
                item = {
                    "id":    produit["_id"],
                    "nom":   produit["name"],
                    "brand": produit.get("brand", ""),
                    "prix":  produit.get("price", prod_prix or 0),
                }
            else:
                item = {"id": None, "nom": prod_nom, "brand": "", "prix": prod_prix or 0}

            session["panier"].append(item)
            session["produit_en_attente"] = None
            logger.info(f"🛒 Panier {phone}: {[p['nom'] for p in session['panier']]}")

            send_buttons(
                phone,
                f"✨ Ajouté au panier !\n\n🛒 *Ton panier :*\n{format_panier(session['panier'])}\n\nTu veux ajouter autre chose ?",
                [
                    {"id": "add_more_yes", "title": "🛍️ Oui, j'ajoute"},
                    {"id": "add_more_no",  "title": "✅ Non, je finalise"},
                ]
            )
            session["state"] = ADD_MORE

        elif action == "DEMANDER_CONFIRMATION" and prod_nom:
            produit = find_product(catalog, prod_nom)
            if produit:
                session["produit_en_attente"] = {
                    "id":    produit["_id"],
                    "nom":   produit["name"],
                    "brand": produit.get("brand", ""),
                    "prix":  produit.get("price", prod_prix or 0),
                }

    except Exception as e:
        logger.error(f"Erreur chat: {e}")
        send_text(phone, "⚠️ Une erreur s'est produite, réessaie.")


def handle_add_more(phone: str, user_text: str, session: dict):
    # Gestion des boutons interactifs ET du texte libre
    text_lower = user_text.lower()
    add_more_flag = (
        user_text in ("add_more_yes",) or
        any(w in text_lower for w in ["oui", "ajoute", "autre", "yes", "wah", "bghit"])
    )

    if not add_more_flag and user_text not in ("add_more_no",):
        # Analyse IA si ce n'est pas un bouton connu
        try:
            check = ai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": 'Réponds uniquement en JSON: {"add_more": true} si le message indique que la personne veut ajouter autre chose, {"add_more": false} si elle veut finaliser.'},
                    {"role": "user", "content": user_text}
                ],
                response_format={"type": "json_object"}
            )
            result = json.loads(check.choices[0].message.content)
            add_more_flag = result.get("add_more", False)
        except Exception:
            pass

    if add_more_flag:
        send_text(phone, "Super ! 🌸 Qu'est-ce que tu veux ajouter ?")
        session["state"] = CHAT
    else:
        send_text(phone, "Parfait ! 📝 Ton prénom ? 👤")
        session["state"] = GET_PRENOM


def handle_get_prenom(phone: str, user_text: str, session: dict):
    session["prenom"] = user_text.strip()
    send_text(phone, "Ton nom ? 👤")
    session["state"] = GET_NOM

def handle_get_nom(phone: str, user_text: str, session: dict):
    session["nom"] = user_text.strip()
    send_text(phone, "Ton numéro de téléphone ? 📱")
    session["state"] = GET_PHONE

def handle_get_phone(phone: str, user_text: str, session: dict):
    session["phone_client"] = user_text.strip()
    send_text(phone, "Ta wilaya ? 🗺️")
    session["state"] = GET_WILAYA

def handle_get_wilaya(phone: str, user_text: str, session: dict):
    session["wilaya"] = user_text.strip()
    send_text(phone, "Ta commune ? 🏘️")
    session["state"] = GET_COMMUNE

def handle_get_commune(phone: str, user_text: str, session: dict):
    session["commune"] = user_text.strip()
    panier = session.get("panier", [])
    total  = sum(item["prix"] for item in panier)

    recap = (
        f"📋 Récapitulatif de ta commande :\n\n"
        f"🛒 Produits :\n{format_panier(panier)}\n\n"
        f"👤 Prénom : {session.get('prenom')}\n"
        f"👤 Nom : {session.get('nom')}\n"
        f"📱 Téléphone : {session.get('phone_client')}\n"
        f"🗺️ Wilaya : {session.get('wilaya')}\n"
        f"🏘️ Commune : {session.get('commune')}"
    )

    send_buttons(
        phone,
        recap,
        [
            {"id": "confirm_yes", "title": "✅ CONFIRMER"},
            {"id": "confirm_no",  "title": "❌ ANNULER"},
        ]
    )
    session["state"] = CONFIRM_ORDER

def handle_confirm_order(phone: str, user_text: str, session: dict):
    text_lower = user_text.lower()
    confirmed = (
        user_text == "confirm_yes" or
        any(w in text_lower for w in ["confirmer", "confirme", "oui", "yes", "ok", "wah"])
    )

    if not confirmed and user_text != "confirm_no":
        try:
            check = ai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": 'Réponds uniquement en JSON: {"confirmed": true} si le message confirme une commande, {"confirmed": false} sinon.'},
                    {"role": "user", "content": user_text}
                ],
                response_format={"type": "json_object"}
            )
            result    = json.loads(check.choices[0].message.content)
            confirmed = result.get("confirmed", False)
        except Exception:
            confirmed = False

    panier = session.get("panier", [])

    if confirmed and panier:
        total     = sum(item["prix"] for item in panier)
        items_doc = [
            {
                "product":  ObjectId(item["id"]) if item.get("id") else None,
                "name":     item["nom"],
                "quantity": 1,
                "price":    item["prix"],
            }
            for item in panier
        ]

        try:
            order_doc = {
                "customerInfo": {
                    "firstName": session.get("prenom"),
                    "lastName":  session.get("nom"),
                    "phone":     session.get("phone_client"),
                    "wilaya":    session.get("wilaya"),
                    "commune":   session.get("commune"),
                },
                "items":         items_doc,
                "total":         total,
                "deliveryFee":   0,
                "deliveryType":  "home",
                "deliverySpeed": "express",
                "status":        "en attente",
                "source":        "whatsapp",
                "createdAt":     datetime.utcnow(),
                "updatedAt":     datetime.utcnow(),
            }
            result = orders_col.insert_one(order_doc)
            logger.info(f"✅ Commande sauvegardée : {result.inserted_id}")
        except Exception as e:
            logger.error(f"Erreur MongoDB : {e}")

        # Notification admin WhatsApp
        try:
            now       = datetime.now().strftime("%d/%m/%Y %H:%M")
            items_txt = "\n".join([f"  • {i['nom']} — {i['prix']} DA" for i in panier])
            admin_msg = (
                f"🛍️ NOUVELLE COMMANDE TINKERBELLS\n📅 {now}\n\n"
                f"🛒 Produits :\n{items_txt}\n"
                f"💰 Total : {total} DA\n\n"
                f"👤 Prénom : {session.get('prenom')}\n"
                f"👤 Nom : {session.get('nom')}\n"
                f"📱 Téléphone : {session.get('phone_client')}\n"
                f"🗺️ Wilaya : {session.get('wilaya')}\n"
                f"🏘️ Commune : {session.get('commune')}"
            )
            send_text(ADMIN_PHONE, admin_msg)
        except Exception as e:
            logger.error(f"Erreur notif admin : {e}")

        send_text(
            phone,
            "🎉 Commande confirmée ! Merci pour ta confiance 🌸\n"
            "Notre équipe te contactera très bientôt pour la livraison.\n\n"
            "Tinkerbells — La beauté à votre portée ✨"
        )
    else:
        send_text(phone, "❌ Commande annulée. Tu peux continuer à magasiner 🌸")

    reset_session(phone)

# ─────────────────────────────────────────
# 🌐 WEBHOOK FLASK
# ─────────────────────────────────────────

@app.route("/webhook", methods=["GET"])
def verify_webhook():
    """Vérification du webhook par Meta."""
    mode      = request.args.get("hub.mode")
    token     = request.args.get("hub.verify_token")
    challenge = request.args.get("hub.challenge")

    if mode == "subscribe" and token == VERIFY_TOKEN:
        logger.info("✅ Webhook vérifié")
        return challenge, 200
    return "Forbidden", 403


@app.route("/webhook", methods=["POST"])
def receive_message():
    """Réception des messages WhatsApp."""
    data = request.get_json()
    logger.info(f"📩 Reçu: {json.dumps(data)}")

    try:
        entry   = data["entry"][0]
        changes = entry["changes"][0]
        value   = changes["value"]

        # Ignorer les statuts de livraison
        if "statuses" in value:
            return jsonify({"status": "ok"}), 200

        messages = value.get("messages", [])
        if not messages:
            return jsonify({"status": "ok"}), 200

        msg   = messages[0]
        phone = msg["from"]  # Numéro de l'expéditeur

        # Extraire le texte (message texte, bouton interactif ou vocal)
        if msg["type"] == "text":
            user_text = msg["text"]["body"]
        elif msg["type"] == "interactive":
            interactive = msg["interactive"]
            if interactive["type"] == "button_reply":
                user_text = interactive["button_reply"]["id"]
            else:
                return jsonify({"status": "ok"}), 200
        elif msg["type"] == "audio":
            user_text = transcribe_audio(msg["audio"]["id"])
            if not user_text:
                send_text(phone, "Désolée, je n'ai pas pu comprendre ton message vocal 🌸 Tu peux réessayer ou écrire en texte ?")
                return jsonify({"status": "ok"}), 200
            logger.info(f"🎤 Transcription: {user_text}")
        else:
            send_text(phone, "Je comprends les messages texte et vocaux 🌸")
            return jsonify({"status": "ok"}), 200

        session = get_session(phone)
        state   = session["state"]

        # Message de démarrage
        if user_text.lower() in ("bonjour", "salut", "hi", "hello", "start", "مرحبا", "ahlan"):
            reset_session(phone)
            send_text(
                phone,
                "🌸 Bienvenue chez Tinkerbells !\n\nJe suis Mina, votre conseillère beauté 💄\nComment puis-je vous aider ?"
            )
            return jsonify({"status": "ok"}), 200

        # Routage selon l'état
        handlers = {
            CHAT:          handle_chat,
            ADD_MORE:      handle_add_more,
            GET_PRENOM:    handle_get_prenom,
            GET_NOM:       handle_get_nom,
            GET_PHONE:     handle_get_phone,
            GET_WILAYA:    handle_get_wilaya,
            GET_COMMUNE:   handle_get_commune,
            CONFIRM_ORDER: handle_confirm_order,
        }
        handler = handlers.get(state, handle_chat)
        handler(phone, user_text, session)

    except Exception as e:
        logger.error(f"Erreur webhook: {e}")

    return jsonify({"status": "ok"}), 200

# ─────────────────────────────────────────
# ▶️  LANCEMENT
# ─────────────────────────────────────────

if __name__ == "__main__":
    logger.info("✅ Bot WhatsApp Tinkerbells démarré")
    app.run(host="0.0.0.0", port=5000, debug=False)
