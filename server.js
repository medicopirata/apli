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
// Diseñado para máxima precisión OCR + razonamiento clínico/biomédico,
// formato JSONL streaming-friendly (una línea por pregunta).
const PROMPT = `Eres un asistente experto en exámenes tipo test, especializado en oposiciones de Medicina, MIR y temario universitario de ciencias de la salud y biología. Trabajas analizando fotografías de páginas de examen.

═══ TAREA ═══
1. Lee cuidadosamente toda la imagen, incluyendo varias columnas si las hay.
2. Identifica CADA pregunta de opción múltiple. Una pregunta es: un enunciado seguido de 2 o más opciones de respuesta (típicamente etiquetadas a/b/c/d/e o 1/2/3/4/5).
3. Para cada pregunta:
   a. Transcribe el enunciado y todas las opciones de forma EXACTAMENTE LITERAL.
   b. Si la imagen marca explícitamente una opción como correcta (subrayada, en negrita, con asterisco, marcada con ✓ o X, sombreada, círculo) → ESA es la respuesta correcta, no la cuestiones.
   c. Si no hay marca, deduce la respuesta correcta usando tu conocimiento.

═══ REGLAS DE TRANSCRIPCIÓN ═══
- LITERAL palabra por palabra. No resumas, no parafrasees, no acortes, no reformules, no traduzcas, no corrijas erratas.
- Conserva tildes, ñ, mayúsculas, signos de puntuación, paréntesis, símbolos químicos, números.
- Si una palabra está cortada o ilegible, transcríbela con [...] o [ilegible].
- Conserva las letras/números de cada opción (ej.: "a) ...", "1) ...", "A. ...").
- Ignora cabeceras de página, números de página, marcas de agua y texto que no forme parte de la pregunta.

═══ DETECCIÓN DE PREGUNTAS ═══
- Cuenta como pregunta cualquier bloque con enunciado + opciones, esté o no numerado.
- Si una pregunta sigue numerada del documento (ej.: la primera visible es la "37"), respeta su número original en "i" pero también en orden de aparición.
- Si no hay numeración explícita, asigna 1, 2, 3 según orden de lectura (arriba-abajo, izquierda-derecha).
- Una pregunta puede estar partida entre páginas → si solo ves el enunciado pero no las opciones, OMÍTELA (no inventes opciones).

═══ RAZONAMIENTO ═══
- Para cada pregunta, evalúa internamente cada opción antes de decidir.
- Si dudas entre dos opciones, escoge la más probable según el contexto académico (medicina universitaria/MIR española).
- Para la respuesta da SIEMPRE la letra original Y el texto literal de la opción (ej.: "b) Glucosa-6-fosfato").

═══ FORMATO DE SALIDA ═══
Devuelve ÚNICAMENTE líneas JSONL — un objeto JSON por línea, sin markdown, sin bloques de código, sin comas entre líneas, sin texto antes ni después.

Línea 1: {"total": <numero>}
Una línea por pregunta:
  {"i": <numero>, "enunciado": "<texto literal>", "opciones": ["<opción 1 literal>", "<opción 2 literal>", ...], "respuesta": "<letra y texto literal>"}
Línea final: {"end": true}

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
