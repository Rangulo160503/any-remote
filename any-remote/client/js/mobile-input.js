/** Trackpad + direct touch with pointer state machine and smoothing. */

import { PointerController } from "./pointer-controller.js";

const MODE_KEY = "any-remote-touch-mode";

export class MobileInputController {
    constructor(renderer, sendInput, platform) {
        this.renderer = renderer;
        this.platform = platform;
        this.mode = localStorage.getItem(MODE_KEY) || "trackpad";
        this.sensitivity = parseFloat(localStorage.getItem("any-remote-sensitivity") || "1.35");
        this.cursor = { x: 0.5, y: 0.5 };
        this.smooth = { x: 0, y: 0 };
        this.pointer = new PointerController(sendInput, (cx, cy) =>
            this.mode === "direct"
                ? this.renderer.coordsFromClient(cx, cy)
                : { x: this.cursor.x, y: this.cursor.y },
        );
        this.el = document.getElementById("virtual-cursor");
        this._paintCursor();
    }

    setMode(mode) {
        this.mode = mode;
        localStorage.setItem(MODE_KEY, mode);
        document.body.classList.toggle("touch-direct", mode === "direct");
        document.body.classList.toggle("touch-trackpad", mode === "trackpad");
        document.getElementById("btn-touch-mode")?.classList.toggle("active", mode === "trackpad");
        document.getElementById("btn-touch-direct")?.classList.toggle("active", mode === "direct");
        this._paintCursor();
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

    _accel(dx, dy) {
        const s = this.sensitivity * 0.0042;
        this.smooth.x = this.smooth.x * 0.35 + dx * s;
        this.smooth.y = this.smooth.y * 0.35 + dy * s;
        const mag = Math.hypot(this.smooth.x, this.smooth.y);
        const curve = mag < 0.002 ? 0 : Math.min(1.8, 0.6 + mag * 12);
        this.cursor.x = Math.max(0, Math.min(1, this.cursor.x + this.smooth.x * curve));
        this.cursor.y = Math.max(0, Math.min(1, this.cursor.y + this.smooth.y * curve));
        this._paintCursor();
    }

    pointerDown(cx, cy, button = "left") {
        this.pointer.pointerDown(cx, cy, button);
    }

    pointerUp(cx, cy, button) {
        this.pointer.pointerUp(cx, cy, button);
    }

    pointerMove(cx, cy, dx, dy) {
        if (this.mode === "direct") {
            this.pointer.pointerMove(cx, cy);
            return;
        }
        this._accel(dx, dy);
        this.pointer.pointerMove(null, null, true);
    }

    click(cx, cy, button = "left") {
        this.pointer.click(cx, cy, button);
    }

    rightClick(cx, cy) {
        this.pointer.rightClick(cx, cy);
    }

    doubleClick() {
        const { x, y } = this.cursor;
        this.pointer.doubleClickAt(x, y);
    }

    enableDragLock() {
        this.pointer.enableDragLock();
    }

    disableDragLock() {
        this.pointer.disableDragLock();
    }

    get dragLock() {
        return this.pointer.dragLock;
    }
}
