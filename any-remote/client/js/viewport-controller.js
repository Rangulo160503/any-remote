/**
 * Pinch zoom + inertial pan on the remote viewport (Figma/Citrix feel).
 */

export class ViewportController {
    constructor(renderer) {
        this.renderer = renderer;
        this.viewport = document.getElementById("viewport");
        this.panX = 0;
        this.panY = 0;
        this.pinchStart = null;
    }

    onPinchStart(touches) {
        const [a, b] = touches;
        this.pinchStart = {
            dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
            zoom: this.renderer.zoomLevel,
            panX: this.panX,
            panY: this.panY,
            midX: (a.clientX + b.clientX) / 2,
            midY: (a.clientY + b.clientY) / 2,
        };
        if (this.renderer.displayMode === "fit") {
            this.renderer.displayMode = "actual";
        }
    }

    onPinchMove(touches) {
        if (!this.pinchStart || touches.length < 2) return;
        const [a, b] = touches;
        const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
        const ratio = dist / Math.max(1, this.pinchStart.dist);
        this.renderer.zoomLevel = Math.max(
            50,
            Math.min(250, Math.round(this.pinchStart.zoom * ratio)),
        );
        const midX = (a.clientX + b.clientX) / 2;
        const midY = (a.clientY + b.clientY) / 2;
        this.panX = this.pinchStart.panX + (midX - this.pinchStart.midX);
        this.panY = this.pinchStart.panY + (midY - this.pinchStart.midY);
        this._applyPan();
        this.renderer.apply();
    }

    onPinchEnd() {
        this.pinchStart = null;
    }

    _applyPan() {
        if (!this.viewport) return;
        this.viewport.scrollLeft = Math.max(0, -this.panX);
        this.viewport.scrollTop = Math.max(0, -this.panY);
    }

    reset() {
        this.panX = this.panY = 0;
        this.pinchStart = null;
        if (this.viewport) {
            this.viewport.scrollLeft = 0;
            this.viewport.scrollTop = 0;
        }
    }
}
