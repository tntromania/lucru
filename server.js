require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurare Google
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// AI33 Config
const AI33_API_KEY = process.env.AI33_API_KEY; // Adaugă în .env: AI33_API_KEY=cheia_ta
const AI33_BASE_URL = 'https://api.ai33.pro';

// Foldere Stocare
const DOWNLOAD_DIR = path.join(__dirname, 'public', 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// DB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Voice AI conectat la MongoDB!'))
    .catch(err => console.error('❌ Eroare MongoDB:', err));

// Schema User
const UserSchema = new mongoose.Schema({
    googleId: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    name: String,
    picture: String,
    credits: { type: Number, default: 10 },
    voice_characters: { type: Number, default: 3000 },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);

// Middleware Autentificare
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Trebuie să fii logat!" });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (e) { return res.status(401).json({ error: "Sesiune expirată." }); }
};

// ==========================================
// RUTE AUTH
// ==========================================
app.post('/api/auth/google', async (req, res) => {
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: req.body.credential, audience: process.env.GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        let user = await User.findOne({ googleId: payload.sub });

        if (!user) {
            user = new User({
                googleId: payload.sub,
                email: payload.email,
                name: payload.name,
                picture: payload.picture,
                credits: 10,
                voice_characters: 3000
            });
            await user.save();
        }

        const sessionToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({
            token: sessionToken,
            user: { name: user.name, picture: user.picture, credits: user.credits, voice_characters: user.voice_characters }
        });
    } catch (error) { res.status(400).json({ error: "Eroare Google" }); }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
    const user = await User.findById(req.userId);
    res.json({ user: { name: user.name, picture: user.picture, credits: user.credits, voice_characters: user.voice_characters } });
});

// ==========================================
// HELPER: Mapare Nume Voce → voice_id ElevenLabs
// ==========================================
// Acestea sunt voice_id-urile din librăria ElevenLabs (compatibil cu AI33)
// Poți înlocui cu ID-urile exacte din: GET https://api.ai33.pro/v2/voices
const VOICE_ID_MAP = {
    "Paul":       "nPczCjzI2devNBz1zQrb",
    "Drew":       "29vD33N1CtxCmqQRPOHJ",
    "Clyde":      "2EiwWnXFnvU5JabPnv8n",
    "Dave":       "CYw3kZ02Hs0563khs1Fj",
    "Roger":      "CwhRBWXzGAHq8TQ4Fs17",
    "Fin":        "D38z5RcWu1voky8WS1ja",
    "James":      "ZQe5CZNOzWyzPSCn5a3c",
    "Bradford":   "EXAVITQu4vr4xnSDxMaL",
    "Reginald":   "onwK4e9ZLuTAKqWW03F9",
    "Austin":     "g5CIjZEefAph4nQFvHAz",
    "Mark":       "UgBBYS2sOqTuMpoF3BR0",
    "Grimblewood":"N2lVS1w4EtoT3dr4eOWO",
    "Rachel":     "21m00Tcm4TlvDq8ikWAM",
    "Aria":       "9BWtsMINqrJLrRacOk9x",
    "Domi":       "AZnzlk1XvdvUeBnXmlld",
    "Sarah":      "EXAVITQu4vr4xnSDxMaL",
    "Jane":       "Xb7hH8MSUJpSbSDYk0k2",
    "Juniper":    "zcAOhNBS3c14rBihAFp1",
    "Arabella":   "jBpfuIE2acCO8z3wKNLl",
    "Hope":       "ODq5zmih8GrVes37Dx9b",
    "Blondie":    "XrExE9yKIg1WjnnlVkGX",
    "Priyanka":   "c1Yh0AkPmCiEa4bBMJJU",
    "Alexandra":  "ThT5KcBeYPX3keUQqHPh",
    "Monika":     "TX3LPaxmHKxFdv7VOQHJ",
    "Gaming":     "IKne3meq5aSn9XLyUdCD",
    "Kuon":       "pMsXgVXv3BLzUgSXRplE"
};

// ==========================================
// HELPER: Descărcare fișier audio
// ==========================================
function downloadAudio(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            // Urmărire redirect dacă există
            if (response.statusCode === 301 || response.statusCode === 302) {
                file.close();
                return downloadAudio(response.headers.location, dest).then(resolve).catch(reject);
            }
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    });
}

// ==========================================
// HELPER: Polling task AI33 până la finalizare
// ==========================================
async function pollTask(taskId, maxWait = 120000) {
    const interval = 3000; // 3 secunde între verificări
    const maxAttempts = Math.floor(maxWait / interval);

    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, interval));

        const response = await fetch(`${AI33_BASE_URL}/v1/task/${taskId}`, {
            headers: { 'xi-api-key': AI33_API_KEY }
        });

        if (!response.ok) throw new Error(`Polling eșuat: ${response.status}`);

        const task = await response.json();

        if (task.status === 'done') {
            // audio_url poate fi în metadata sau direct în output_uri
            const audioUrl = task.metadata?.audio_url || task.output_uri || task.metadata?.output_uri;
            if (!audioUrl) throw new Error("Task finalizat dar fără URL audio.");
            return audioUrl;
        }

        if (task.status === 'error' || task.status === 'failed') {
            throw new Error(task.error_message || "Eroare la generarea vocii în AI33.");
        }

        console.log(`⏳ Polling task ${taskId}: status=${task.status}, attempt=${i + 1}`);
    }

    throw new Error("Timeout: generarea a durat prea mult.");
}

// ==========================================
// RUTĂ GENERARE VOCE (AI33 - ElevenLabs TTS)
// ==========================================
app.post('/api/generate', authenticate, async (req, res) => {
    try {
        const { text, voice, stability, similarity_boost, speed } = req.body;
        const user = await User.findById(req.userId);

        if (!text) return res.status(400).json({ error: "Script text lipsă." });

        // Cost calculat fără spații (identic cu logica anterioară)
        const textWithoutSpaces = text.replace(/\s+/g, '');
        const cost = textWithoutSpaces.length;

        if (user.voice_characters < cost) {
            return res.status(403).json({ error: `Fonduri insuficiente. Ai nevoie de ${cost} caractere.` });
        }

        // Determinăm voice_id
        const voiceId = VOICE_ID_MAP[voice] || VOICE_ID_MAP["Paul"];
        const modelId = "eleven_multilingual_v2"; // sau eleven_turbo_v2_5 pentru viteză mai mare

        console.log(`🎙️ Generare voce AI33: ${voice} (${voiceId}) pentru ${user.name}`);

        // Apel către AI33 TTS
        const ai33Response = await fetch(
            `${AI33_BASE_URL}/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'xi-api-key': AI33_API_KEY
                },
                body: JSON.stringify({
                    text: text,
                    model_id: modelId,
                    voice_settings: {
                        stability: parseFloat(stability) || 0.5,
                        similarity_boost: parseFloat(similarity_boost) || 0.75,
                        speed: parseFloat(speed) || 1.0
                    },
                    with_transcript: false
                })
            }
        );

        if (!ai33Response.ok) {
            const errBody = await ai33Response.text();
            console.error("Eroare AI33:", ai33Response.status, errBody);

            if (ai33Response.status === 429) {
                return res.status(429).json({ error: "Sistemul este suprasolicitat. Te rugăm să aștepți câteva secunde între generări!" });
            }
            if (ai33Response.status === 401) {
                return res.status(500).json({ error: "Cheie API AI33 invalidă. Contactează administratorul." });
            }
            throw new Error(`AI33 a returnat eroare ${ai33Response.status}`);
        }

        const ai33Data = await ai33Response.json();

        if (!ai33Data.success || !ai33Data.task_id) {
            throw new Error("AI33 nu a returnat un task_id valid.");
        }

        console.log(`✅ Task AI33 creat: ${ai33Data.task_id}`);

        // Așteptăm finalizarea task-ului (polling)
        const outputUrl = await pollTask(ai33Data.task_id);

        // Descărcăm fișierul audio pe server
        const fileName = `voice_${Date.now()}.mp3`;
        const filePath = path.join(DOWNLOAD_DIR, fileName);
        await downloadAudio(outputUrl, filePath);

        // Scădem caracterele și salvăm
        user.voice_characters -= cost;
        await user.save();

        res.json({ audioUrl: `/downloads/${fileName}`, remaining_chars: user.voice_characters });

    } catch (error) {
        console.error("ERROR VOICE GEN:", error.message || error);

        if (error.message && error.message.includes('429')) {
            return res.status(429).json({ error: "Sistemul este suprasolicitat. Te rugăm să aștepți câteva secunde între generări!" });
        }

        res.status(500).json({ error: error.message || "Eroare tehnică la generarea vocii. Încearcă din nou." });
    }
});

// ==========================================
// CURĂȚARE FIȘIERE VECHI (24h)
// ==========================================
setInterval(() => {
    fs.readdir(DOWNLOAD_DIR, (err, files) => {
        if (err) return;
        files.forEach(file => {
            const filePath = path.join(DOWNLOAD_DIR, file);
            fs.stat(filePath, (err, stats) => {
                if (!err && (Date.now() - stats.mtimeMs > 86400000)) fs.unlink(filePath, () => {});
            });
        });
    });
}, 3600000);

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Voice Studio (AI33) rulează pe portul ${PORT}!`));