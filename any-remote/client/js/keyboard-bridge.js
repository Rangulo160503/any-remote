/** iOS software keyboard bridge via hidden input. */

const CODE_MAP = {
    Space: "space",
    Enter: "enter",
    Backspace: "backspace",
    Escape: "esc",
    Tab: "tab",
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
};

export class KeyboardBridge {
    constructor(sendInput) {
        this.send = sendInput;
        this.input = document.getElementById("hidden-input");
        this.visible = false;
        this._bind();
    }

    _bind() {
        if (!this.input) return;
        this.input.addEventListener("keydown", (e) => this._key(e, true));
        this.input.addEventListener("keyup", (e) => this._key(e, false));
        this.input.addEventListener("input", () => {
            const v = this.input.value;
            if (!v) return;
            for (const ch of v) {
                this.send({ t: "keydown", key: ch, code: `Key${ch.toUpperCase()}` });
                this.send({ t: "keyup", key: ch, code: `Key${ch.toUpperCase()}` });
            }
            this.input.value = "";
        });
        window.addEventListener("keydown", (e) => this._desktopKey(e), true);
        window.addEventListener("keyup", (e) => this._desktopKey(e, false), true);
    }

    _resolve(code) {
        if (CODE_MAP[code]) return CODE_MAP[code];
        if (code?.startsWith("Key") && code.length === 4) return code.slice(3).toLowerCase();
        if (code?.startsWith("Digit") && code.length === 6) return code.slice(5);
        return null;
    }

    _key(e, down) {
        const key = this._resolve(e.code);
        if (!key) return;
        e.preventDefault();
        this.send(down ? { t: "keydown", key, code: e.code } : { t: "keyup", key, code: e.code });
    }

    _desktopKey(e, down = true) {
        if (!document.body.classList.contains("session-live")) return;
        const key = this._resolve(e.code);
        if (!key) return;
        e.preventDefault();
        this.send(down ? { t: "keydown", key, code: e.code } : { t: "keyup", key, code: e.code });
    }

    toggle() {
        this.visible = !this.visible;
        if (!this.input) return;
        if (this.visible) {
            this.input.classList.remove("hidden");
            this.input.focus();
        } else {
            this.input.classList.add("hidden");
            this.input.blur();
        }
    }

    show() {
        this.visible = true;
        this.input?.classList.remove("hidden");
        this.input?.focus();
    }
}
