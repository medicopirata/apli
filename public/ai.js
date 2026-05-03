// === Cliente de IA con streaming SSE ===
// Lee el endpoint /api/analyze (SSE), acumula deltas de texto y va
// disparando callbacks conforme se completan líneas JSONL del modelo.
// Esto permite que la voz empiece a dictar en cuanto llega la primera
// pregunta, sin esperar a que termine toda la generación.

const ENDPOINT = "/api/analyze";

/**
 * @typedef {Object} StreamCallbacks
 * @property {(total:number) => void} [onTotal]
 * @property {(q:{i:number, enunciado:string, respuesta:string}) => void} [onQuestion]
 * @property {() => void} [onEnd]
 * @property {(rawSoFar:string) => void} [onRaw]
 */

/**
 * Envía la imagen al backend y procesa el streaming SSE.
 * @param {string} base64Image  JPEG en base64 (sin prefijo data:).
 * @param {StreamCallbacks} callbacks
 */
export async function analyzeImageStream(base64Image, callbacks = {}) {
    const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64Image, mimeType: "image/jpeg" })
    });

    if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(`Backend ${res.status}: ${text || res.statusText}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let sseBuffer  = "";   // buffer para eventos SSE
    let textBuffer = "";   // buffer para JSONL acumulado del modelo
    let totalSeen  = false;
    let endSeen    = false;

    const mark = (key) => {
        if (key === "total") totalSeen = true;
        if (key === "end")   endSeen   = true;
    };

    let rawText = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });

        // Cada evento SSE termina en \n\n
        let idx;
        while ((idx = sseBuffer.indexOf("\n\n")) !== -1) {
            const rawEvent = sseBuffer.slice(0, idx);
            sseBuffer = sseBuffer.slice(idx + 2);

            for (const line of rawEvent.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (!payload) continue;

                let data;
                try { data = JSON.parse(payload); } catch { continue; }

                if (data.error) throw new Error(data.error);

                if (data.delta) {
                    rawText += data.delta;
                    callbacks.onRaw?.(rawText);
                    textBuffer = consumeJsonl(textBuffer + data.delta, callbacks, mark);
                }

                if (data.done) {
                    // Procesa el resto del buffer (última línea sin \n final)
                    if (textBuffer.trim()) {
                        consumeJsonl(textBuffer + "\n", callbacks, mark);
                        textBuffer = "";
                    }
                    if (!totalSeen) callbacks.onTotal?.(0);
                    if (!endSeen)   callbacks.onEnd?.();
                    return rawText;
                }
            }
        }
    }

    // Stream cerrado sin {done: true} → cierre limpio
    if (textBuffer.trim()) consumeJsonl(textBuffer + "\n", callbacks, mark);
    if (!totalSeen) callbacks.onTotal?.(0);
    if (!endSeen)   callbacks.onEnd?.();
    return rawText;
}

/**
 * Consume líneas completas del buffer JSONL y dispara callbacks.
 * Devuelve la línea parcial restante (aún sin \n).
 */
function consumeJsonl(buffer, callbacks, mark) {
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let obj;
        try { obj = JSON.parse(line); }
        catch { console.warn("JSONL inválido (ignorado):", line); continue; }

        if (typeof obj.total === "number") {
            mark("total");
            callbacks.onTotal?.(obj.total);
        } else if (obj.enunciado && obj.respuesta) {
            callbacks.onQuestion?.({
                i: Number(obj.i) || 0,
                enunciado: String(obj.enunciado),
                respuesta: String(obj.respuesta)
            });
        } else if (obj.end === true) {
            mark("end");
            callbacks.onEnd?.();
        }
    }
    return buffer;
}
