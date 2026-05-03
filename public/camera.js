// === Módulo de cámara ===
// Encapsula getUserMedia, gestión del stream y captura de fotograma.

export class Camera {
    constructor(videoEl, canvasEl) {
        this.video = videoEl;
        this.canvas = canvasEl;
        this.stream = null;
    }

    async start() {
        if (this.stream) return;

        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error("Tu navegador no soporta acceso a la cámara. Usa Chrome o Safari recientes.");
        }

        const constraints = {
            audio: false,
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            }
        };

        try {
            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
            // Fallback: pedir cualquier cámara si la trasera no está disponible
            if (err.name === "OverconstrainedError" || err.name === "NotFoundError") {
                this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
            } else if (err.name === "NotAllowedError") {
                throw new Error("Permiso de cámara denegado. Habilítalo desde los ajustes del navegador.");
            } else {
                throw new Error(`No se pudo acceder a la cámara: ${err.message}`);
            }
        }

        this.video.srcObject = this.stream;
        await new Promise((resolve) => {
            this.video.onloadedmetadata = () => {
                this.video.play().then(resolve).catch(resolve);
            };
        });
    }

    stop() {
        if (this.stream) {
            this.stream.getTracks().forEach((t) => t.stop());
            this.stream = null;
            this.video.srcObject = null;
        }
    }

    /**
     * Calcula una "huella" reducida en escala de grises del fotograma actual
     * (48×48 píxeles) para detectar estabilidad/contenido sin coste de red.
     * Devuelve null si el vídeo no está listo aún.
     * @returns {{ bytes: Uint8Array, mean: number, variance: number } | null}
     */
    getSignature() {
        const W = 48, H = 48;
        if (!this.video.videoWidth || !this.video.videoHeight) return null;

        if (!this._sigCanvas) {
            this._sigCanvas = document.createElement("canvas");
            this._sigCanvas.width = W;
            this._sigCanvas.height = H;
            this._sigCtx = this._sigCanvas.getContext("2d", { willReadFrequently: true });
        }
        try {
            this._sigCtx.drawImage(this.video, 0, 0, W, H);
        } catch {
            return null;
        }

        const px = this._sigCtx.getImageData(0, 0, W, H).data;
        const bytes = new Uint8Array(W * H);
        let sum = 0;
        for (let i = 0, j = 0; i < px.length; i += 4, j++) {
            // Luminancia rápida (Rec. 601 con shift)
            const g = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
            bytes[j] = g;
            sum += g;
        }
        const mean = sum / bytes.length;
        let variance = 0;
        for (let i = 0; i < bytes.length; i++) {
            const d = bytes[i] - mean;
            variance += d * d;
        }
        variance /= bytes.length;
        return { bytes, mean, variance };
    }

    /**
     * Captura el fotograma actual y lo devuelve como base64 (sin el prefijo data:).
     * @param {number} maxWidth Ancho máximo (manteniendo aspecto). Por defecto 1600.
     * @param {number} quality JPEG quality 0-1. Por defecto 0.85.
     * @returns {{ base64: string, mimeType: string, dataUrl: string }}
     */
    capture(maxWidth = 1600, quality = 0.85) {
        const vw = this.video.videoWidth;
        const vh = this.video.videoHeight;

        if (!vw || !vh) {
            throw new Error("La cámara aún no está lista. Espera un momento.");
        }

        const scale = Math.min(1, maxWidth / vw);
        const cw = Math.round(vw * scale);
        const ch = Math.round(vh * scale);

        this.canvas.width = cw;
        this.canvas.height = ch;
        const ctx = this.canvas.getContext("2d");
        ctx.drawImage(this.video, 0, 0, cw, ch);

        const dataUrl = this.canvas.toDataURL("image/jpeg", quality);
        const base64 = dataUrl.split(",")[1];

        return { base64, mimeType: "image/jpeg", dataUrl };
    }
}
