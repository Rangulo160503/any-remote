/** Adaptive quality — startup profile, ramp-up, input-priority under load. */

export class QualityController {
    constructor(platform, sendFn) {
        this.platform = platform;
        this.send = sendFn;
        this.mode = platform.mobile ? "mobile" : "balanced";
        this.userMode = this.mode;
        this.lastAdapt = 0;
        this.stablePlayback = false;
        this.rampStage = 0;
    }

    effectiveQuality(userMode) {
        this.userMode = userMode || this.userMode;
        if (this.platform.mobile && !this.stablePlayback) {
            return "startup_mobile";
        }
        if (this.platform.isSafariMobile && this.userMode === "balanced" && !this.stablePlayback) {
            return "startup_mobile";
        }
        return this.userMode;
    }

    onFirstFrame() {
        this.lastAdapt = 0;
    }

    onStableRamp() {
        this.stablePlayback = true;
        this.rampStage = 1;
    }

    onMeta(msg) {
        if (msg.quality) {
            this.mode = msg.quality;
            this.userMode = msg.quality;
        }
    }

    tick(hud, fps) {
        const now = Date.now();
        const loss = hud.data.packetLoss ?? 0;
        const rtt = hud.data.rttMs ?? 0;

        if (loss > 0.12 || rtt > 280) {
            this._sendAdapt("startup_mobile", 450_000, 8, loss, rtt, true);
            this.lastAdapt = now;
            return;
        }

        if (now - this.lastAdapt < 4000) return;

        let mode = this.userMode;
        let bitrate = 550_000;
        let targetFps = 8;

        if (!this.platform.mobile) {
            mode = this.userMode;
            bitrate =
                mode === "ultra" ? 6_000_000 : mode === "high" ? 4_000_000 : 2_500_000;
            targetFps = 15;
        } else if (!this.stablePlayback) {
            mode = "startup_mobile";
            bitrate = 550_000;
            targetFps = 8;
        } else if (this.rampStage === 1) {
            mode = "mobile";
            bitrate = 750_000;
            targetFps = 10;
            if (fps >= 8) this.rampStage = 2;
        } else {
            mode = this.userMode === "balanced" ? "mobile" : this.userMode;
            bitrate = mode === "high" ? 1_200_000 : 900_000;
            targetFps = 12;
        }

        this._sendAdapt(mode, bitrate, targetFps, loss, rtt, false);
        this.lastAdapt = now;
    }

    _sendAdapt(mode, bitrate, fps, loss, rtt, inputPriority) {
        this.send({
            t: "adapt",
            mode,
            bitrate,
            fps,
            packetLoss: loss,
            rtt,
            inputPriority,
        });
        if (inputPriority) {
            console.log("[any-remote] adapt input-priority", bitrate);
        }
    }
}
