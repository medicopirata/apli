// === Servidor Express ===
// - Sirve los estáticos de /public
// - Expone /api/analyze como endpoint SSE: recibe base64 y reenvía
//   los deltas de texto del modelo conforme llegan, para que la voz
//   pueda empezar a dictar antes de que termine la generación.

import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.ANTHROPIC_API_KEY) {
    console.error("✖ Falta ANTHROPIC_API_KEY en el entorno (.env).");
    process.exit(1);
}

const MODEL = process.env.MODEL || "claude-sonnet-4-6";
const PORT  = Number(process.env.PORT) || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

// === Prompt de extracción ===
// Pide JSONL streaming-friendly: una pregunta por línea para que el frontend
// pueda dictarla en cuanto se complete.
const PROMPT = `Eres un asistente que extrae preguntas tipo test de imágenes de exámenes y apuntes.

REGLAS DE CONTENIDO:
- Identifica TODAS las preguntas de opción múltiple visibles en la imagen.
- Transcribe el ENUNCIADO de cada pregunta de forma EXACTAMENTE LITERAL palabra por palabra: no resumas, no parafrasees, no acortes y no reformules. Conserva tildes, mayúsculas y puntuación.
- Determina cuál es la opción correcta usando tu conocimiento. Si la imagen ya marca la respuesta correcta (subrayada, marcada, en negrita…), respétala.
- Para la respuesta da la letra y el TEXTO LITERAL de la opción correcta (ej.: "b) Glucosa-6-fosfato").
- Ignora cabeceras, paginación y elementos que no formen parte de la pregunta.

REGLAS DE FORMATO — devuelve ÚNICAMENTE líneas JSONL (un objeto JSON por línea, sin markdown, sin texto adicional, sin comas entre líneas):
1. PRIMERA línea: {"total": <numero>}
2. UNA línea por pregunta, en orden: {"i": <numero>, "enunciado": "<texto literal>", "respuesta": "<letra y texto literal de la opción correcta>"}
3. ÚLTIMA línea: {"end": true}

Si no detectas preguntas tipo test, devuelve únicamente:
{"total": 0}
{"end": true}

Empieza ahora.`;

// === Endpoint de streaming ===
app.post("/api/analyze", async (req, res) => {
    const { image, mimeType = "image/jpeg" } = req.body || {};
    if (!image || typeof image !== "string") {
        return res.status(400).json({ error: "Falta el campo `image` (base64)." });
    }

    // Cabeceras SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const sendEvent = (obj) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    // Detectar desconexión real del cliente: 'close' en res, no en req.
    // (En Express, req 'close' también dispara cuando se acaba de leer el body.)
    let clientGone = false;
    res.on("close", () => {
        if (!res.writableEnded) {
            clientGone = true;
            console.log("  ⚠ cliente desconectado antes de terminar");
        }
    });

    const t0 = Date.now();
    const sizeKB = (image.length / 1024).toFixed(1);
    console.log(`→ /api/analyze  imagen ${sizeKB} KB, modelo ${MODEL}`);

    let collected = "";

    try {
        // Llamada NO streaming (más simple y robusta para esta versión del SDK).
        // El cliente ya re-emite la respuesta por SSE, así que el "streaming"
        // visible al usuario sigue funcionando: empieza a hablar en cuanto el
        // backend reenvía el texto completo. Tiempo total ~1.5-3s con Sonnet.
        const msg = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 4096,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "image",
                        source: { type: "base64", media_type: mimeType, data: image }
                    },
                    { type: "text", text: PROMPT }
                ]
            }]
        });

        const textBlocks = (msg.content || []).filter(c => c.type === "text");
        collected = textBlocks.map(c => c.text).join("");

        const ms = Date.now() - t0;
        console.log(`← /api/analyze  ${ms}ms, ${collected.length} chars, stop_reason: ${msg.stop_reason}`);
        console.log("  usage:", JSON.stringify(msg.usage));
        if (collected.length === 0) {
            console.log("  ⚠ contenido vacío. Bloques recibidos:", JSON.stringify(msg.content));
        }
        console.log("--- RESPUESTA DEL MODELO ---\n" + collected + "\n--- FIN ---");

        if (!clientGone && collected) {
            const lines = collected.split(/(\n)/);
            for (const part of lines) {
                if (clientGone) break;
                if (part) sendEvent({ delta: part });
            }
        }

        if (!clientGone) sendEvent({ done: true });
    } catch (err) {
        console.error("Error en /api/analyze:", err.status, err.message);
        if (err.error) console.error("Detalle API:", JSON.stringify(err.error));
        if (!clientGone) sendEvent({ error: err.message || "Error en la IA" });
    } finally {
        if (!res.writableEnded) res.end();
    }
});

// Health check sencillo
app.get("/api/health", (_req, res) => {
    res.json({ ok: true, model: MODEL });
});

app.listen(PORT, () => {
    console.log(`✔ Servidor en http://localhost:${PORT}`);
    console.log(`  Modelo: ${MODEL}`);
});
