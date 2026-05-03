// === Lógica principal de la aplicación ===
// Modo automático: detecta páginas estables ante la cámara y dispara
// el escaneo + dictado sin intervención. Tras dictar, espera 8s para
// que el usuario pase de página y vuelve a buscar.

import { Camera } from "./camera.js";
import { Speech } from "./speech.js";
import { analyzeImageStream } from "./ai.js";

// === DOM ===
const $video        = document.getElementById("video");
const $canvas       = document.getElementById("canvas");
const $cameraView   = document.querySelector(".camera-view");
const $statusText   = document.getElementById("status-text");
const $scanBtn      = document.getElementById("scan-btn");
const $stopBtn      = document.getElementById("stop-btn");
const $loading      = document.getElementById("loading");
const $loadingText  = document.getElementById("loading-text");
const $errorOverlay = document.getElementById("error");
const $errorText    = document.getElementById("error-text");
const $errorClose   = document.getElementById("error-close");
const $fileInput    = document.getElementById("file-input");
const $preview      = document.getElementById("preview");
const $previewImg   = document.getElementById("preview-img");
const $debugToggle  = document.getElementById("debug-toggle");
const $debugPanel   = document.getElementById("debug-panel");
const $debugClose   = document.getElementById("debug-close");
const $debugCamera  = document.getElementById("debug-camera");
const $debugCapture = document.getElementById("debug-capture");
const $debugRaw     = document.getElementById("debug-raw");
const $debugQs      = document.getElementById("debug-questions");
const $autoToggle   = document.getElementById("auto-toggle");
const $btBlock      = document.getElementById("bt-block");
const $btRecheck    = document.getElementById("bt-block-recheck");
const $btBypass     = document.getElementById("bt-block-bypass");
const $btText       = document.getElementById("bt-block-text");

// === Servicios y estado ===
const camera = new Camera($video, $canvas);
const speech = new Speech();
let busy = false;
let speechChain = Promise.resolve();
let _audioBlocked = false;
const enqueueSpeech = (text) => {
    if (_audioBlocked) return Promise.resolve();
    speechChain = speechChain.then(() => {
        if (_audioBlocked) return;
        return speech.speak(text);
    });
    return speechChain;
};

// === Auto-detección ===
const DETECT_INTERVAL_MS   = 400;     // cada cuánto sampleamos la cámara
const STABILITY_DIFF_MAX   = 7;       // diff medio por píxel para "estable"
const STABLE_FRAMES_NEEDED = 4;       // ~1.6s de quietud → captura
const MIN_VARIANCE         = 150;     // mínima riqueza visual (no pared blanca/negra)
const MOVEMENT_DIFF_MIN    = 18;      // diff que cuenta como "movimiento real"
const MIN_SHARPNESS        = 350;     // varianza Laplaciana mínima → captura nítida
const COOLDOWN_MS          = 8000;    // pausa tras dictar (pase de página)

let autoMode       = true;
let detectInterval = null;
let prevSig        = null;
let stableCount    = 0;
let needsMovement  = false;            // true tras un escaneo, hasta detectar movimiento
let cooldownUntil  = 0;

function meanAbsDiff(a, b) {
    let sum = 0;
    const n = a.length;
    for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
    return sum / n;
}

function startAutoDetect() {
    stopAutoDetect();
    if (!autoMode) return;
    detectInterval = setInterval(autoDetectTick, DETECT_INTERVAL_MS);
}

function stopAutoDetect() {
    if (detectInterval) clearInterval(detectInterval);
    detectInterval = null;
    prevSig = null;
    stableCount = 0;
}

function autoDetectTick() {
    if (!autoMode || busy) return;

    // Cooldown: esperando para que el usuario pase de página
    const remaining = cooldownUntil - Date.now();
    if (remaining > 0) {
        setStatus(`Pasa de página… ${Math.ceil(remaining / 1000)}s`);
        return;
    }

    const sig = camera.getSignature();
    if (!sig) return;

    // Sin contenido → resetea contador
    if (sig.variance < MIN_VARIANCE) {
        stableCount = 0;
        prevSig = sig;
        setStatus("Apunta a una página con texto");
        return;
    }

    if (prevSig) {
        const diff = meanAbsDiff(prevSig.bytes, sig.bytes);

        // Tras un escaneo necesitamos movimiento antes de re-disparar,
        // para no procesar la misma página dos veces.
        if (needsMovement) {
            if (diff > MOVEMENT_DIFF_MIN) {
                needsMovement = false;
                stableCount = 0;
                setStatus("Buscando nueva página…");
            } else {
                setStatus("Mueve a la siguiente página");
            }
            prevSig = sig;
            return;
        }

        if (diff < STABILITY_DIFF_MAX) {
            stableCount++;
            const pct = Math.min(100, Math.round((stableCount / STABLE_FRAMES_NEEDED) * 100));
            setStatus(`Detectando página… ${pct}%`);
            $cameraView.classList.add("scanning");
            if (stableCount >= STABLE_FRAMES_NEEDED) {
                // Comprobación final de nitidez antes de gastar API call.
                const sharp = camera.getSharpness();
                if (sharp < MIN_SHARPNESS) {
                    stableCount = Math.max(1, STABLE_FRAMES_NEEDED - 1);
                    setStatus(`Imagen borrosa (${Math.round(sharp)}) — sujeta más fija…`);
                    prevSig = sig;
                    return;
                }
                stableCount = 0;
                $cameraView.classList.remove("scanning");
                triggerAutoScan();
                return;
            }
        } else {
            stableCount = 0;
            $cameraView.classList.remove("scanning");
            setStatus("Buscando página…");
        }
    } else {
        setStatus("Buscando página…");
    }
    prevSig = sig;
}

async function triggerAutoScan() {
    try {
        const { base64, dataUrl } = camera.capture(2200, 0.9);
        await processBase64(base64, dataUrl, /*fromAuto=*/true);
    } catch (err) {
        console.error(err);
        setStatus("Error capturando — reintentando…");
    }
}

// === Helpers UI ===
const setStatus    = (t) => { $statusText.textContent = t; };
const showLoading  = (t = "Analizando…") => { $loadingText.textContent = t; $loading.hidden = false; };
const hideLoading  = () => { $loading.hidden = true; };
const showError    = (msg) => { $errorText.textContent = msg; $errorOverlay.hidden = false; };
const hideError    = () => { $errorOverlay.hidden = true; };
const setScanning  = (on) => { $cameraView.classList.toggle("scanning", on); $scanBtn.disabled = on; };
const setSpeaking  = (on) => { $cameraView.classList.toggle("speaking", on); $stopBtn.hidden = !on; };

const showPreview = (dataUrl) => {
    $previewImg.src = dataUrl;
    $preview.hidden = false;
};

// === Diagnóstico de cámara ===
function refreshCameraDebug() {
    if (!camera.stream) {
        $debugCamera.textContent = "Cámara: NO iniciada";
        return;
    }
    const track = camera.stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() || {};
    const sharp = camera.getSharpness();
    const lines = [
        `Estado: activa`,
        `Track label: ${track?.label || "(desconocido)"}`,
        `Resolución: ${settings.width || "?"} × ${settings.height || "?"}`,
        `Modo: ${settings.facingMode || "(desconocido)"}`,
        `FPS: ${settings.frameRate || "?"}`,
        `Video size: ${$video.videoWidth} × ${$video.videoHeight}`,
        `Nitidez (Laplacian var): ${Math.round(sharp)}  (umbral ${MIN_SHARPNESS})`,
        `Auto-detect: ${autoMode ? "ON" : "OFF"}`,
        `Stable count: ${stableCount}/${STABLE_FRAMES_NEEDED}`,
        `Cooldown: ${Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000))}s`
    ];
    $debugCamera.textContent = lines.join("\n");
}

// === Detección de auriculares Bluetooth ===
// Android Chrome no expone audiooutputs de forma fiable: a veces la lista
// está vacía o sin etiquetas. Por eso usamos un enfoque mixto:
//
//   1) Pantalla inicial OBLIGATORIA donde el usuario confirma manualmente
//      "tengo los auriculares conectados".
//   2) En ese momento congelamos un snapshot de audiooutputs (count + IDs).
//   3) Cada 2 s comparamos: si el número de outputs baja respecto al snapshot,
//      o si alguno de los IDs originales desaparece, asumimos desconexión y
//      bloqueamos. Esto NO depende de etiquetas.
//   4) Al reconectar/recuperar el snapshot original (o iguales/más dispositivos),
//      el usuario puede volver a confirmar.

let _audioRefSnapshot = null;   // { count, ids } al confirmar el usuario
let _btPollInterval = null;
let _micWarmupTried = false;

async function warmUpAudioLabels() {
    if (_micWarmupTried) return;
    _micWarmupTried = true;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
    } catch (e) {
        console.warn("Warmup de audio falló:", e.message);
    }
}

async function listAudioOutputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        return devs.filter(d => d.kind === "audiooutput");
    } catch {
        return [];
    }
}

function renderBtOverlay(outputs, mode = "initial") {
    const list = outputs.length
        ? outputs.map(d => `• ${d.label || "(sin etiqueta)"}`).join("\n")
        : "(el navegador no expuso audiooutputs)";
    const intro = mode === "initial"
        ? "Conecta los auriculares Bluetooth y pulsa el botón cuando estén listos. La app pausará sola si los desconectas."
        : "Se ha desconectado un dispositivo de audio. Vuelve a conectar los auriculares Bluetooth y pulsa Volver a comprobar.";
    $btText.textContent = `${intro}\n\nSalidas detectadas ahora:\n${list}`;
    // Cambia el texto del botón según el contexto
    $btRecheck.textContent = mode === "initial"
        ? "Tengo auriculares conectados — empezar"
        : "Volver a comprobar";
}

function showBtBlock(outputs, mode) {
    renderBtOverlay(outputs, mode);
    $btBlock.hidden = false;
    _audioBlocked = true;
    speech.cancel();
    speechChain = Promise.resolve();
    stopAutoDetect();
    setStatus("Pausado — sin auriculares Bluetooth");
}

function hideBtBlock() {
    _audioBlocked = false;
    $btBlock.hidden = true;
}

async function snapshotAudio() {
    const outputs = await listAudioOutputs();
    _audioRefSnapshot = {
        count: outputs.length,
        ids: outputs.map(d => d.deviceId),
        labels: outputs.map(d => d.label)
    };
    console.info("Snapshot audio:", _audioRefSnapshot);
}

async function checkAudioStillConnected() {
    if (!_audioRefSnapshot) return true;
    const outputs = await listAudioOutputs();
    const currentIds = new Set(outputs.map(d => d.deviceId));

    // Cualquiera de los IDs originales que falte → desconexión.
    const missing = _audioRefSnapshot.ids.filter(id => !currentIds.has(id));
    if (missing.length > 0) {
        console.warn("Dispositivos perdidos:", missing);
        return false;
    }
    // Alternativa: el conteo bajó (algunos navegadores reciclan IDs).
    if (outputs.length < _audioRefSnapshot.count) {
        console.warn("Conteo de outputs bajó:", outputs.length, "<", _audioRefSnapshot.count);
        return false;
    }
    return true;
}

async function audioWatchdog() {
    if (_audioBlocked) return;          // ya bloqueado
    if (!_audioRefSnapshot) return;     // aún no confirmado
    const ok = await checkAudioStillConnected();
    if (!ok) {
        const outputs = await listAudioOutputs();
        showBtBlock(outputs, "disconnect");
        _audioRefSnapshot = null;
    }
}

function startBtPolling() {
    if (_btPollInterval) return;
    _btPollInterval = setInterval(audioWatchdog, 2000);
}

if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", audioWatchdog);
}

async function startAfterBtOk() {
    if (!camera.stream) {
        try { await camera.start(); } catch (e) { console.error(e); return; }
    }
    if (autoMode) startAutoDetect();
    requestWakeLock();
    setStatus("Buscando página…");
}

// === Wake Lock: evita que la pantalla se apague mientras la app está abierta ===
let _wakeLock = null;
async function requestWakeLock() {
    if (!("wakeLock" in navigator)) {
        console.info("Wake Lock no soportado en este navegador");
        return;
    }
    try {
        _wakeLock = await navigator.wakeLock.request("screen");
        _wakeLock.addEventListener("release", () => {
            _wakeLock = null;
        });
        console.info("Wake lock activo: pantalla no se apagará");
    } catch (err) {
        console.warn("No se pudo activar wake lock:", err.message);
    }
}

// Re-pide el lock al volver al foreground (Android lo libera al ocultar pestaña).
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !_wakeLock) {
        requestWakeLock();
    }
});

// === Inicialización ===
async function init() {
    try {
        setStatus("Solicitando acceso a la cámara…");
        await camera.start();
        refreshCameraDebug();
        setInterval(refreshCameraDebug, 1000);

        // Warmup de mic para que se vean labels/IDs de audiooutput
        await warmUpAudioLabels();

        // SIEMPRE se muestra la pantalla inicial: el usuario confirma
        // manualmente que tiene auriculares conectados antes de empezar.
        const outputs = await listAudioOutputs();
        showBtBlock(outputs, "initial");
        startBtPolling();
    } catch (err) {
        console.error("Error iniciando cámara:", err);
        $debugCamera.textContent = `ERROR: ${err.message}\n\nPuedes usar "Subir imagen" como alternativa.`;
        setStatus("Cámara no disponible — usa Subir imagen");
        showError(err.message || "No se pudo iniciar la cámara.");
    }
}

// === Procesado común (cámara o archivo) ===
async function processBase64(base64, dataUrl, fromAuto = false) {
    if (busy) return;
    busy = true;

    speech.cancel();
    speechChain = Promise.resolve();

    showPreview(dataUrl);
    $debugCapture.textContent = `Tamaño base64: ${(base64.length / 1024).toFixed(1)} KB`;
    $debugRaw.textContent = "(esperando…)";
    $debugQs.textContent = "(ninguna aún)";

    let firstChunkReceived = false;
    let questionsList = [];

    try {
        showLoading("Analizando con IA…");
        setStatus("Analizando con IA…");
        $scanBtn.disabled = true;

        const startTime = performance.now();
        const rawText = await analyzeImageStream(base64, {
            onRaw: (raw) => {
                $debugRaw.textContent = raw || "(vacío)";
            },
            onTotal: (n) => {
                firstChunkReceived = true;
                hideLoading();
                setSpeaking(true);

                const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
                console.log(`[${elapsed}s] total: ${n}`);

                if (n === 0) {
                    setStatus("No se encontraron preguntas.");
                    enqueueSpeech("No se han encontrado preguntas en esta página.");
                } else {
                    setStatus(`${n} ${n === 1 ? "pregunta" : "preguntas"} — dictando…`);
                    enqueueSpeech(`${n} ${n === 1 ? "pregunta encontrada" : "preguntas encontradas"}.`);
                }
            },
            onQuestion: (q) => {
                questionsList.push(q);
                $debugQs.textContent = JSON.stringify(questionsList, null, 2);
                enqueueSpeech(`Pregunta ${q.i}: ${q.enunciado}.`);
                enqueueSpeech(`Respuesta correcta: ${q.respuesta}.`);
            },
            onEnd: () => {
                enqueueSpeech("Fin.");
            }
        });

        $debugRaw.textContent = rawText || "(vacío)";

        if (!firstChunkReceived) {
            hideLoading();
            setStatus("La IA no devolvió datos válidos — abre Diagnóstico");
            enqueueSpeech("No se han encontrado preguntas.");
        }

        await speechChain;

        setSpeaking(false);
        $scanBtn.disabled = false;

        if (autoMode) {
            cooldownUntil = Date.now() + COOLDOWN_MS;
            needsMovement = true;
            stableCount = 0;
            prevSig = null;
            setStatus(`Pasa de página… ${COOLDOWN_MS / 1000}s`);
        } else {
            setStatus("Listo. Pulsa Escanear para la siguiente.");
        }

    } catch (err) {
        console.error(err);
        speech.cancel();
        hideLoading();
        setSpeaking(false);
        $scanBtn.disabled = false;
        if (!firstChunkReceived) {
            showError(err.message || "Error procesando la página.");
        } else {
            setStatus("Error a mitad de proceso.");
        }
        if (autoMode) {
            cooldownUntil = Date.now() + COOLDOWN_MS;
            needsMovement = true;
        }
    } finally {
        busy = false;
    }
}

// === Captura manual desde botón ===
async function handleScan() {
    if (busy) return;
    try {
        setStatus("Capturando…");
        const { base64, dataUrl } = camera.capture(2200, 0.9);
        await processBase64(base64, dataUrl, /*fromAuto=*/false);
    } catch (err) {
        console.error(err);
        showError(err.message || "Error capturando imagen.");
    }
}

// === Subida desde archivo ===
async function handleFileUpload(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    ev.target.value = "";
    try {
        setStatus("Procesando imagen subida…");
        const dataUrl = await readFileAsDataUrl(file);
        const resized = await resizeDataUrl(dataUrl, 2200, 0.9);
        const base64 = resized.dataUrl.split(",")[1];
        await processBase64(base64, resized.dataUrl, /*fromAuto=*/false);
    } catch (err) {
        console.error(err);
        showError(err.message || "No se pudo leer el archivo.");
    }
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload  = () => resolve(r.result);
        r.onerror = () => reject(new Error("Error leyendo el archivo"));
        r.readAsDataURL(file);
    });
}

function resizeDataUrl(dataUrl, maxWidth, quality) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, maxWidth / img.width);
            const w = Math.round(img.width * scale);
            const h = Math.round(img.height * scale);
            const c = document.createElement("canvas");
            c.width = w; c.height = h;
            c.getContext("2d").drawImage(img, 0, 0, w, h);
            resolve({ dataUrl: c.toDataURL("image/jpeg", quality), width: w, height: h });
        };
        img.onerror = () => reject(new Error("Imagen inválida"));
        img.src = dataUrl;
    });
}

// === Detener voz ===
function handleStop() {
    speech.cancel();
    speechChain = Promise.resolve();
    setSpeaking(false);
    busy = false;
    if (autoMode) {
        cooldownUntil = Date.now() + COOLDOWN_MS;
        needsMovement = true;
    } else {
        setStatus("Detenido. Pulsa Escanear para la siguiente.");
    }
}

// === Toggle auto/manual ===
function handleAutoToggle() {
    autoMode = $autoToggle.checked;
    if (autoMode) {
        startAutoDetect();
        setStatus("Buscando página…");
    } else {
        stopAutoDetect();
        $cameraView.classList.remove("scanning");
        setStatus("Modo manual — pulsa Escanear");
    }
}

// === Eventos ===
$scanBtn.addEventListener("click", handleScan);
$stopBtn.addEventListener("click", handleStop);
$errorClose.addEventListener("click", hideError);
$fileInput.addEventListener("change", handleFileUpload);
$autoToggle.addEventListener("change", handleAutoToggle);

$debugToggle.addEventListener("click", () => {
    refreshCameraDebug();
    $debugPanel.hidden = false;
});
$debugClose.addEventListener("click", () => { $debugPanel.hidden = true; });

$btRecheck.addEventListener("click", async () => {
    // Confirma estado actual: snapshot + start
    await snapshotAudio();
    hideBtBlock();
    await startAfterBtOk();
});
$btBypass.addEventListener("click", async () => {
    // Continuar sin monitorización — el usuario sabe lo que hace.
    _audioRefSnapshot = null;
    if (_btPollInterval) { clearInterval(_btPollInterval); _btPollInterval = null; }
    hideBtBlock();
    await startAfterBtOk();
});

window.addEventListener("pagehide", () => {
    stopAutoDetect();
    camera.stop();
    speech.cancel();
});

// Desbloqueo de TTS + sesión de audio "media" tras primer gesto del usuario.
// El segundo paso (AudioContext con un buffer silencioso en bucle) fuerza
// a Android Chrome a clasificar la salida como STREAM_MUSIC, lo que hace
// que la voz se enrute a auriculares Bluetooth/cable y no al altavoz.
let _audioCtx = null;
document.addEventListener("click", function unlockSpeech() {
    try {
        const u = new SpeechSynthesisUtterance("");
        u.volume = 0;
        window.speechSynthesis.speak(u);
    } catch (_) { /* noop */ }

    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx && !_audioCtx) {
            _audioCtx = new Ctx();
            // Buffer de 1 s totalmente silencioso, en loop infinito.
            const buf = _audioCtx.createBuffer(1, _audioCtx.sampleRate, _audioCtx.sampleRate);
            const src = _audioCtx.createBufferSource();
            src.buffer = buf;
            src.loop = true;
            // Pasamos por un gain a 0.0001 — algunos navegadores no consideran
            // "playing" un nodo cuyo destino lleva 0 absoluto.
            const gain = _audioCtx.createGain();
            gain.gain.value = 0.0001;
            src.connect(gain).connect(_audioCtx.destination);
            src.start();
            // Si el contexto entra en estado "suspended", lo reanudamos.
            if (_audioCtx.state === "suspended") _audioCtx.resume().catch(() => {});
        }
    } catch (_) { /* noop */ }

    document.removeEventListener("click", unlockSpeech);
}, { once: true });

// Si el navegador suspende el AudioContext (p.ej. al volver de background),
// lo reanudamos en cualquier interacción posterior.
document.addEventListener("visibilitychange", () => {
    if (!document.hidden && _audioCtx?.state === "suspended") {
        _audioCtx.resume().catch(() => {});
    }
});

init();
