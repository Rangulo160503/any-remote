/** Adaptive bitrate/FPS for mobile Safari. */

export class QualityController {
    constructor(platform, sendFn) {
        this.platform = platform;
        this.send = sendFn;
        this.mode = platform.mobile ? "mobile" : "balanced";
        this.lastAdapt = 0;
        this.freezeCount = 0;
        this.lastFps = 0;
    }

    effectiveQuality(userMode) {
        if (this.platform.isSafariMobile && userMode === "balanced") return "mobile";
        return userMode;
    }

    onMeta(msg) {
        if (msg.quality) this.mode = msg.quality;
    }

    tick(hud, fps) {
        const now = Date.now();
        if (fps <= 2 && this.lastFps > 5) this.freezeCount++;
        else if (fps > 8) this.freezeCount = Math.max(0, this.freezeCount - 1);
        this.lastFps = fps;

        if (now - this.lastAdapt < 5000) return;

        const loss = hud.data.packetLoss;
        const rtt = hud.data.rttMs;
        let bitrate = 850_000;
        let targetFps = 10;
        let mode = "mobile";

        if (!this.platform.mobile) {
            mode = this.mode === "mobile" ? "balanced" : this.mode;
            if (mode === "high") bitrate = 4_000_000;
            else if (mode === "ultra") bitrate = 6_000_000;
            else bitrate = 2_500_000;
            targetFps = 15;
        } else {
            if (loss != null && loss > 0.08) bitrate = 700_000;
            if (rtt != null && rtt > 250) bitrate = Math.min(bitrate, 750_000);
            if (this.freezeCount >= 3) {
                bitrate = 650_000;
                targetFps = 8;
            }
        }

        this.lastAdapt = now;
        this.send({
            t: "adapt",
            mode,
            bitrate,
            fps: targetFps,
            packetLoss: loss,
            rtt,
        });
        console.log("[any-remote] adapt", mode, bitrate, targetFps, "loss", loss);
    }
}
