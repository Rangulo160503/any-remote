/** Virtual cursor + direct / trackpad touch modes. */

const MODE_KEY = "any-remote-touch-mode";

export class MobileInputController {
    constructor(renderer, sendInput, platform) {
        this.renderer = renderer;
        this.sendInput = sendInput;
        this.platform = platform;
        this.mode = localStorage.getItem(MODE_KEY) || "trackpad";
        this.sensitivity = parseFloat(localStorage.getItem("any-remote-sensitivity") || "1.2");
        this.cursor = { x: 0.5, y: 0.5 };
        this.drag = { active: false, button: null };
        this.lastMove = 0;
        this.el = null;
        this.overlay = document.getElementById("touch-overlay");
        this._initCursor();
    }

    _initCursor() {
        this.el = document.getElementById("virtual-cursor");
        if (!this.el && this.overlay) {
            this.el = document.createElement("div");
            this.el.id = "virtual-cursor";
            this.overlay.appendChild(this.el);
        }
        this._paintCursor();
    }

    setMode(mode) {
        this.mode = mode;
        localStorage.setItem(MODE_KEY, mode);
        document.body.classList.toggle("touch-direct", mode === "direct");
        document.body.classList.toggle("touch-trackpad", mode === "trackpad");
        document.getElementById("btn-touch-mode")?.classList.toggle("active", mode === "trackpad");
        document.getElementById("btn-touch-direct")?.classList.toggle("active", mode === "direct");
    }

    toggleMode() {
        this.setMode(this.mode === "trackpad" ? "direct" : "trackpad");
    }

    _paintCursor() {
        if (!this.el || this.mode !== "trackpad") {
            if (this.el) this.el.style.display = "none";
            return;
        }
        this.el.style.display = "block";
        const { width, height } = this.renderer.layoutDimensions();
        this.el.style.left = `${this.cursor.x * width}px`;
        this.el.style.top = `${this.cursor.y * height}px`;
    }

    _normFromDirect(clientX, clientY) {
        return this.renderer.coordsFromClient(clientX, clientY);
    }

    _moveCursor(dx, dy) {
        const sens = this.sensitivity * 0.0035;
        this.cursor.x = Math.max(0, Math.min(1, this.cursor.x + dx * sens));
        this.cursor.y = Math.max(0, Math.min(1, this.cursor.y + dy * sens));
        this._paintCursor();
        const now = Date.now();
        const interval = this.drag.active ? 16 : 33;
        if (now - this.lastMove < interval) return;
        this.lastMove = now;
        this.sendInput({ t: "move", x: this.cursor.x, y: this.cursor.y });
    }

    pointerDown(clientX, clientY, button = "left") {
        let coords;
        if (this.mode === "direct") {
            coords = this._normFromDirect(clientX, clientY);
            if (!coords) return;
        } else {
            coords = { x: this.cursor.x, y: this.cursor.y };
        }
        this.drag = { active: true, button };
        this.sendInput({ t: "down", button, x: coords.x, y: coords.y });
    }

    pointerUp(clientX, clientY) {
        if (!this.drag.active) return;
        let coords;
        if (this.mode === "direct" && clientX != null) {
            coords = this._normFromDirect(clientX, clientY) || { x: this.cursor.x, y: this.cursor.y };
        } else {
            coords = { x: this.cursor.x, y: this.cursor.y };
        }
        this.sendInput({ t: "up", button: this.drag.button || "left", x: coords.x, y: coords.y });
        this.drag = { active: false, button: null };
        document.body.classList.remove("remote-drag");
    }

    pointerMove(clientX, clientY, dx, dy) {
        if (this.mode === "direct") {
            const c = this._normFromDirect(clientX, clientY);
            if (c) {
                const now = Date.now();
                if (now - this.lastMove >= (this.drag.active ? 16 : 33)) {
                    this.lastMove = now;
                    this.sendInput({ t: "move", x: c.x, y: c.y });
                }
            }
            return;
        }
        this._moveCursor(dx, dy);
    }

    scroll(dx, dy) {
        const step = 0.04;
        this.cursor.y = Math.max(0, Math.min(1, this.cursor.y + dy * step));
        this._paintCursor();
        this.sendInput({ t: "move", x: this.cursor.x, y: this.cursor.y });
    }

    doubleClick() {
        const { x, y } = this.cursor;
        this.sendInput({ t: "down", button: "left", x, y });
        this.sendInput({ t: "up", button: "left", x, y });
        setTimeout(() => {
            this.sendInput({ t: "down", button: "left", x, y });
            this.sendInput({ t: "up", button: "left", x, y });
        }, 80);
    }
}
