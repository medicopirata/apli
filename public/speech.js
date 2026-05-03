// === Módulo de síntesis de voz ===
// Cola serializada de mensajes con SpeechSynthesisUtterance en es-ES.

export class Speech {
    constructor() {
        this.synth = window.speechSynthesis;
        this.voice = null;
        this.lang = "es-ES";
        this.rate = 1.0;   // velocidad
        this.pitch = 1.0;  // tono
        this.queue = [];
        this.speaking = false;
        this.cancelled = false;

        if (!this.synth) {
            console.warn("speechSynthesis no disponible en este navegador.");
            return;
        }

        // Cargar voces (en algunos navegadores son asíncronas)
        this._loadVoice();
        if (typeof this.synth.onvoiceschanged !== "undefined") {
            this.synth.onvoiceschanged = () => this._loadVoice();
        }
    }

    _loadVoice() {
        const voices = this.synth.getVoices();
        if (!voices.length) return;

        // Preferencias en orden: voz es-ES local > es-ES > cualquier es-*
        this.voice =
            voices.find((v) => v.lang === "es-ES" && v.localService) ||
            voices.find((v) => v.lang === "es-ES") ||
            voices.find((v) => v.lang?.startsWith("es")) ||
            null;
    }

    /**
     * Encola un texto y devuelve una promesa que se resuelve cuando termina de hablarse.
     * Si se cancela todo (cancel()), las promesas pendientes se resuelven igualmente.
     */
    speak(text) {
        if (!this.synth) return Promise.resolve();
        if (!text || !text.trim()) return Promise.resolve();

        return new Promise((resolve) => {
            const utter = new SpeechSynthesisUtterance(text);
            utter.lang = this.lang;
            utter.rate = this.rate;
            utter.pitch = this.pitch;
            utter.volume = 1.0;
            if (this.voice) utter.voice = this.voice;

            utter.onend = () => resolve();
            utter.onerror = () => resolve();

            // Workaround para Chrome: si lleva mucho hablando se queda colgado
            this.synth.speak(utter);
        });
    }

    /**
     * Dicta una secuencia de cadenas en orden, una tras otra.
     * @param {string[]} parts
     */
    async speakSequence(parts) {
        this.cancelled = false;
        this.speaking = true;
        try {
            for (const part of parts) {
                if (this.cancelled) break;
                await this.speak(part);
            }
        } finally {
            this.speaking = false;
        }
    }

    cancel() {
        this.cancelled = true;
        if (this.synth) this.synth.cancel();
    }
}
