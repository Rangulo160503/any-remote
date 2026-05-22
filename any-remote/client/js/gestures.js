/**
 * Citrix-style gesture map — tap, drag lock, scroll, pinch, right-click.
 */

import { ScrollEngine } from "./scroll-engine.js";
import { ViewportController } from "./viewport-controller.js";

export class GestureController {
    constructor(mobileInput, keyboard, canInput, sendInput) {
        this.input = mobileInput;
        this.keyboard = keyboard;
        this.canInput = canInput;
        this.scroll = new ScrollEngine(sendInput, mobileInput.pointer);
        this.viewport = new ViewportController(mobileInput.renderer);
        this.lastTap = 0;
        this.tapCount = 0;
        this.longPressTimer = null;
        this.dragLockPending = false;
        this.twoFingerMoved = false;
        this.mode = "none";
        this.lastTouch = { x: 0, y: 0 };
        this._bind();
    }

    _bind() {
        const layer = document.getElementById("touch-overlay");
        if (!layer) return;
        const opts = { passive: false };
        layer.addEventListener("touchstart", (e) => this._onStart(e), opts);
        layer.addEventListener("touchmove", (e) => this._onMove(e), opts);
        layer.addEventListener("touchend", (e) => this._onEnd(e), opts);
        layer.addEventListener("touchcancel", (e) => this._onEnd(e), opts);
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
            this.mode = "two-finger";
            this.twoFingerMoved = false;
            const a = e.touches[0];
            const b = e.touches[1];
            this.lastTouch = {
                x: (a.clientX + b.clientX) / 2,
                y: (a.clientY + b.clientY) / 2,
            };
            this.viewport.onPinchStart([a, b]);
            return;
        }

        const t = e.touches[0];
        if (!t) return;
        this.mode = "one-finger";
        this.lastTouch = { x: t.clientX, y: t.clientY };
        const now = Date.now();

        if (this.input.dragLock) {
            this.input.disableDragLock();
            return;
        }

        if (now - this.lastTap < 320) {
            this.tapCount++;
            if (this.tapCount >= 2) {
                this.dragLockPending = true;
                this.longPressTimer = setTimeout(() => {
                    if (this.canInput() && this.dragLockPending) {
                        this.input.enableDragLock();
                        this.dragLockPending = false;
                    }
                }, 280);
                return;
            }
        } else {
            this.tapCount = 1;
        }
        this.lastTap = now;

        this.longPressTimer = setTimeout(() => {
            if (!this.canInput() || this.dragLockPending) return;
            this.input.pointerDown(t.clientX, t.clientY, "left");
        }, 500);
    }

    _onMove(e) {
        e.preventDefault();
        if (!this.canInput()) return;

        if (e.touches.length === 2 && this.mode === "two-finger") {
            const [a, b] = [e.touches[0], e.touches[1]];
            const dx = (a.clientX + b.clientX) / 2 - this.lastTouch.x;
            const dy = (a.clientY + b.clientY) / 2 - this.lastTouch.y;
            if (Math.hypot(dx, dy) > 8) {
                this.twoFingerMoved = true;
                this.scroll.feed(dx, dy);
            }
            this.viewport.onPinchMove([a, b]);
            this.lastTouch = {
                x: (a.clientX + b.clientX) / 2,
                y: (a.clientY + b.clientY) / 2,
            };
            return;
        }

        const t = e.touches[0];
        if (!t) return;
        const dx = t.clientX - this.lastTouch.x;
        const dy = t.clientY - this.lastTouch.y;
        if (Math.hypot(dx, dy) > 5) {
            clearTimeout(this.longPressTimer);
            this.dragLockPending = false;
        }

        if (this.input.pointer.anyDown || this.input.dragLock) {
            this.input.pointerMove(t.clientX, t.clientY, dx, dy);
        } else if (this.input.mode === "trackpad") {
            this.input.pointerMove(t.clientX, t.clientY, dx, dy);
        }
        this.lastTouch = { x: t.clientX, y: t.clientY };
    }

    _onEnd(e) {
        e.preventDefault();
        clearTimeout(this.longPressTimer);
        if (!this.canInput()) return;

        if (this.mode === "two-finger" && e.touches.length === 0) {
            if (!this.twoFingerMoved) {
                const t = e.changedTouches[0];
                this.input.rightClick(t?.clientX, t?.clientY);
            }
            this.viewport.onPinchEnd();
            this.mode = "none";
            if (this.input.pointer.anyDown) {
                this.input.pointer.releaseAll();
            }
            return;
        }

        const t = e.changedTouches[0];
        const now = Date.now();

        if (this.dragLockPending && !this.input.dragLock) {
            this.input.doubleClick();
            this.dragLockPending = false;
            this.tapCount = 0;
            this.mode = "none";
            return;
        }

        if (this.input.dragLock) {
            this.mode = "none";
            return;
        }

        if (this.input.pointer.anyDown) {
            this.input.pointerUp(t?.clientX, t?.clientY);
        } else if (t && now - this.lastTap < 280 && this.tapCount === 1) {
            this.input.click(t.clientX, t.clientY, "left");
        }

        this.mode = "none";
        this.dragLockPending = false;
    }
}
