/** Textarea bridge + clipboard sync + modifiers. */

const CODE_MAP = {
    Space: "space",
    Enter: "enter",
    Backspace: "backspace",
    Escape: "esc",
    Tab: "tab",
    Delete: "delete",
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
    MetaLeft: "command",
    MetaRight: "command",
    ControlLeft: "ctrl",
    ControlRight: "ctrl",
    ShiftLeft: "shift",
    ShiftRight: "shift",
    AltLeft: "alt",
    AltRight: "alt",
};

export class KeyboardBridge {
    constructor(sendInput) {
        this.send = sendInput;
        this.field = document.getElementById("hidden-text");
        this.visible = false;
        this.remoteClipboard = "";
        this._bind();
    }

    _bind() {
        if (!this.field) return;
        this.field.addEventListener("keydown", (e) => this._key(e, true));
        this.field.addEventListener("keyup", (e) => this._key(e, false));
        this.field.addEventListener("input", () => this._onInput());
        this.field.addEventListener("paste", (e) => this._onPaste(e));
        window.addEventListener("keydown", (e) => this._desktopKey(e, true), true);
        window.addEventListener("keyup", (e) => this._desktopKey(e, false), true);
    }

    _resolve(code, key) {
        if (CODE_MAP[code]) return CODE_MAP[code];
        if (code?.startsWith("Key") && code.length === 4) return code.slice(3).toLowerCase();
        if (code?.startsWith("Digit") && code.length === 6) return code.slice(5);
        if (key?.length === 1) return key;
        return null;
    }

    _key(e, down) {
        if (e.metaKey && e.key === "v" && down) {
            this.pasteFromSystem();
            e.preventDefault();
            return;
        }
        if (e.metaKey && e.key === "c") {
            e.preventDefault();
            return;
        }
        const k = this._resolve(e.code, e.key);
        if (!k) return;
        e.preventDefault();
        this.send(down ? { t: "keydown", key: k, code: e.code } : { t: "keyup", key: k, code: e.code });
    }

    _desktopKey(e, down = true) {
        if (!document.body.classList.contains("session-live")) return;
        this._key(e, down);
    }

    _onInput() {
        const v = this.field.value;
        if (!v) return;
        this.send({ t: "clipboard", text: v });
        this.field.value = "";
    }

    async _onPaste(e) {
        e.preventDefault();
        await this.pasteFromSystem();
    }

    async pasteFromSystem() {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                this.send({ t: "clipboard", text });
            }
        } catch (_) {
            const t = this.field?.value;
            if (t) this.send({ t: "clipboard", text: t });
        }
    }

    async copyToLocal(text) {
        this.remoteClipboard = text || "";
        try {
            await navigator.clipboard.writeText(this.remoteClipboard);
        } catch (_) {}
    }

    toggle() {
        this.visible = !this.visible;
        if (!this.field) return;
        if (this.visible) {
            this.field.classList.remove("hidden");
            this.field.focus();
        } else {
            this.field.classList.add("hidden");
            this.field.blur();
        }
    }

    show() {
        this.visible = true;
        this.field?.classList.remove("hidden");
        this.field?.focus();
    }
}
