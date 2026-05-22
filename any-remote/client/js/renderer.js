/** Viewport layout — Safari-safe: never remount video/container DOM. */

import { getRemoteVideoSingleton } from "./video-singleton.js";

export class Renderer {
    constructor(platform) {
        this.platform = platform;
        this.zoomLevel = 100;
        this.displayMode = "fit";
        this.hostMeta = null;
        this.container = document.getElementById("desktop-container");
        this.viewport = document.getElementById("viewport");
        this.video = getRemoteVideoSingleton();
    }

    /** Detach stream only — singleton video element survives peer reconnect. */
    detachVideo() {
        if (this.video) this.video.srcObject = null;
    }

    streamSize() {
        const vw = this.video.videoWidth || 0;
        const vh = this.video.videoHeight || 0;
        return {
            w: vw || this.hostMeta?.streamW || 960,
            h: vh || this.hostMeta?.streamH || 540,
        };
    }

    layoutDimensions() {
        const { w: sw, h: sh } = this.streamSize();
        const pad = this.platform.mobile ? 4 : 32;
        const maxW = Math.max(120, this.viewport.clientWidth - pad);
        const maxH = Math.max(120, this.viewport.clientHeight - pad);

        if (this.displayMode === "fit") {
            const scale = Math.min(maxW / sw, maxH / sh, 1);
            return {
                width: Math.max(1, Math.round(sw * scale)),
                height: Math.max(1, Math.round(sh * scale)),
            };
        }
        const z = this.zoomLevel / 100;
        return {
            width: Math.max(1, Math.round(sw * z)),
            height: Math.max(1, Math.round(sh * z)),
        };
    }

    apply() {
        const { width, height } = this.layoutDimensions();
        this.container.style.width = `${width}px`;
        this.container.style.height = `${height}px`;
        this.video.style.width = `${width}px`;
        this.video.style.height = `${height}px`;
        const zl = document.getElementById("zoom-label");
        if (zl) zl.textContent = `${this.zoomLevel}%`;
        document.getElementById("btn-fit")?.classList.toggle("active", this.displayMode === "fit");
        document.getElementById("btn-actual")?.classList.toggle("active", this.displayMode === "actual");
    }

    setMeta(meta) {
        this.hostMeta = meta;
        this.apply();
    }

    coordsFromClient(clientX, clientY) {
        const rect = this.video.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const x = (clientX - rect.left) / rect.width;
        const y = (clientY - rect.top) / rect.height;
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    }
}
