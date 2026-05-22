/**
 * Inertial two-finger scroll — smoothed wheel deltas for remote host.
 */

export class ScrollEngine {
    constructor(sendInput, pointer) {
        this.send = sendInput;
        this.pointer = pointer;
        this.vx = 0;
        this.vy = 0;
        this.lastWheelMs = 0;
        this._raf = null;
    }

    feed(dx, dy) {
        const scale = 0.35;
        this.vx = this.vx * 0.55 + dx * scale;
        this.vy = this.vy * 0.55 + dy * scale;
        this._schedule();
    }

    _schedule() {
        if (this._raf) return;
        const tick = () => {
            this._raf = null;
            const now = Date.now();
            if (now - this.lastWheelMs < 24) {
                this._schedule();
                return;
            }
            if (Math.abs(this.vx) < 0.4 && Math.abs(this.vy) < 0.4) {
                this.vx = this.vy = 0;
                return;
            }
            const { x, y } = this.pointer.lastSent;
            const dy = -Math.round(this.vy);
            const dx = Math.round(this.vx);
            this.send({
                t: "wheel",
                x,
                y,
                dx,
                dy,
            });
            this.vx *= 0.82;
            this.vy *= 0.82;
            this.lastWheelMs = now;
            this._schedule();
        };
        this._raf = requestAnimationFrame(tick);
    }
}
