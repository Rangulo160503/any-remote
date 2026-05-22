/** Multi-touch gestures for mobile remote control. */

export class GestureController {
    constructor(mobileInput, keyboard, canInput) {
        this.input = mobileInput;
        this.keyboard = keyboard;
        this.canInput = canInput;
        this.lastTap = 0;
        this.longPressTimer = null;
        this.pinchStart = null;
        this.lastTouch = { x: 0, y: 0 };
        this.scrollMode = false;
        this._bind();
    }

    _bind() {
        const layer = document.getElementById("touch-overlay");
        if (!layer) return;
        const opts = { passive: false };

        layer.addEventListener(
            "touchstart",
            (e) => this._onStart(e),
            opts,
        );
        layer.addEventListener("touchmove", (e) => this._onMove(e), opts);
        layer.addEventListener("touchend", (e) => this._onEnd(e), opts);
        layer.addEventListener("touchcancel", (e) => this._onEnd(e), opts);
    }

    _touches(e) {
        return Array.from(e.changedTouches);
    }

    _onStart(e) {
        e.preventDefault();
        if (!this.canInput()) return;
        const n = e.touches.length;
        if (n === 3) {
            this.keyboard.toggle();
            return;
        }
        if (n === 2) {
            this.scrollMode = true;
            const [a, b] = [e.touches[0], e.touches[1]];
            this.pinchStart = {
                dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
                zoom: this.input.renderer.zoomLevel,
            };
            return;
        }
        const t = e.touches[0];
        if (!t) return;
        this.lastTouch = { x: t.clientX, y: t.clientY };
        this.longPressTimer = setTimeout(() => {
            if (this.canInput()) this.input.pointerDown(t.clientX, t.clientY, "left");
        }, 450);
    }

    _onMove(e) {
        e.preventDefault();
        if (!this.canInput()) return;
        if (e.touches.length === 2 && this.scrollMode) {
            const [a, b] = [e.touches[0], e.touches[1]];
            const midY = (a.clientY + b.clientY) / 2;
            const midX = (a.clientX + b.clientX) / 2;
            this.input.scroll(midX - this.lastTouch.x, midY - this.lastTouch.y);
            this.lastTouch = { x: midX, y: midY };
            if (this.pinchStart) {
                const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
                const delta = (dist - this.pinchStart.dist) * 0.08;
                const r = this.input.renderer;
                r.zoomLevel = Math.max(50, Math.min(200, this.pinchStart.zoom + delta));
                if (r.displayMode === "fit") r.displayMode = "actual";
                r.apply();
            }
            return;
        }
        const t = e.touches[0];
        if (!t) return;
        const dx = t.clientX - this.lastTouch.x;
        const dy = t.clientY - this.lastTouch.y;
        if (Math.hypot(dx, dy) > 8) clearTimeout(this.longPressTimer);
        this.input.pointerMove(t.clientX, t.clientY, dx, dy);
        this.lastTouch = { x: t.clientX, y: t.clientY };
    }

    _onEnd(e) {
        e.preventDefault();
        clearTimeout(this.longPressTimer);
        if (e.touches.length > 0) return;
        if (!this.canInput()) return;

        if (this.scrollMode) {
            this.scrollMode = false;
            this.pinchStart = null;
            this.input.pointerUp(null, null);
            return;
        }

        const t = this._touches(e)[0];
        const now = Date.now();
        if (t && now - this.lastTap < 300) {
            this.input.doubleClick();
            this.lastTap = 0;
            return;
        }
        this.lastTap = now;

        if (e.touches.length === 0 && e.changedTouches.length === 2) {
            this.input.pointerDown(t?.clientX, t?.clientY, "right");
            this.input.pointerUp(t?.clientX, t?.clientY);
            return;
        }

        if (this.input.drag.active) {
            this.input.pointerUp(t?.clientX, t?.clientY);
        } else if (t) {
            this.input.pointerDown(t.clientX, t.clientY, "left");
            this.input.pointerUp(t.clientX, t.clientY);
        }
    }
}
