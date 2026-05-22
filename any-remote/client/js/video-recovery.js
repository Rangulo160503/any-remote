/**
 * Safari rendering stabilization — freeze detection + local recovery ONLY (no page reload).
 * Never recreates <video>; reattaches stable MediaStream + load() + play().
 */

import {
    applyInlinePlaybackFlags,
    forcePlayVideo,
    getRemoteVideoSingleton,
    startAutoplayRetryLoop,
    stopAutoplayRetryLoop,
} from "./video-singleton.js";
import {
    attachTrackToStableStream,
    bindStableStreamToVideo,
    detachStableFromVideo,
    getStableMediaStream,
} from "./media-stream.js";
import { configureLowLatencyReceiver } from "./safari-compat.js";

const HAVE_CURRENT_DATA = 2;

export class VideoRecoveryMonitor {
    constructor(platform, hooks) {
        this.platform = platform;
        this.hooks = hooks;
        this.video = getRemoteVideoSingleton();
        this.receiver = null;
        this.track = null;

        const sm = platform.isSafariMobile;
        this.freezeMs = sm ? 3000 : 4500;
        this.checkMs = sm ? 500 : 900;
        this.allowPeerHardRecover = !sm;

        this.lastCurrentTime = -1;
        this.lastAdvanceWallMs = 0;
        this.recovering = false;
        this.freezeDetected = false;
        this.fpsFrames = 0;
        this.fpsWindowStart = performance.now();
        this.framesDecoded = 0;
        this.health = "idle";
        this._timer = null;
        this._rvfActive = false;
        this._enabled = false;
        this.graceUntil = 0;
        this._visibilityBound = false;
    }

    getVideoTrack() {
        return (
            getStableMediaStream().getVideoTracks()[0] ||
            this.track ||
            null
        );
    }

    sample() {
        const v = this.video;
        const track = this.getVideoTrack();
        if (!v) return null;
        const ct = v.currentTime;
        const ctDelta =
            this.lastCurrentTime >= 0 ? ct - this.lastCurrentTime : 0;

        return {
            playing: !v.paused && !v.ended,
            paused: v.paused,
            readyState: v.readyState,
            currentTime: ct,
            ctDelta,
            ended: v.ended,
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
            trackMuted: track?.muted ?? null,
            trackReadyState: track?.readyState ?? null,
            streamActive: v.srcObject?.active ?? null,
            freezeDetected: this.freezeDetected,
            framesDecoded: this.framesDecoded,
        };
    }

    _pushWatchdog(sample) {
        this.hooks.onWatchdog?.(sample);
    }

    analyze(sample) {
        const reasons = [];
        const now = Date.now();
        const peerUp = this.hooks.isPeerConnected?.() ?? false;
        const live = this.hooks.isSessionLive?.() ?? false;

        if (!live || !peerUp || !this.video.srcObject) {
            this.freezeDetected = false;
            return { frozen: false, black: false, reasons: ["no-session"] };
        }

        const ct = sample.currentTime;
        if (ct > this.lastCurrentTime + 0.001) {
            this.lastAdvanceWallMs = now;
            this.lastCurrentTime = ct;
            this.freezeDetected = false;
        } else if (
            this.lastCurrentTime >= 0 &&
            now - this.lastAdvanceWallMs > this.freezeMs
        ) {
            reasons.push("currentTime-frozen-3s");
            this.freezeDetected = true;
        }

        if (sample.paused && !sample.ended) reasons.push("paused");
        if (sample.readyState < HAVE_CURRENT_DATA) reasons.push(`readyState-${sample.readyState}`);
        if (sample.ended) reasons.push("ended");

        const black =
            peerUp &&
            sample.videoWidth === 0 &&
            sample.videoHeight === 0 &&
            now - this.lastAdvanceWallMs > this.freezeMs;

        if (black) reasons.push("black-frame");

        const frozen = reasons.length > 0 && (this.freezeDetected || sample.paused || sample.readyState < 2);

        return { frozen, black, reasons };
    }

    bindTrack(evt) {
        this.receiver = evt.receiver ?? null;
        this.track = evt.track ?? null;
        if (this.track) {
            this.track.enabled = true;
            attachTrackToStableStream(this.track);
            bindStableStreamToVideo(this.video);
            this.track.onunmute = () => this._renderRecover("unmute");
            this.track.onmute = () => console.warn("[any-remote] track muted");
        }
        configureLowLatencyReceiver(this.receiver);
        applyInlinePlaybackFlags(this.video);
        forcePlayVideo();
        startAutoplayRetryLoop();
        this._setHealth("ok");
    }

    clearMedia() {
        this.stop();
        stopAutoplayRetryLoop();
        this.receiver = null;
        this.track = null;
        this.lastCurrentTime = -1;
        detachStableFromVideo(this.video);
        this._setHealth("idle");
    }

    start() {
        this.stop();
        this._enabled = true;
        this.lastAdvanceWallMs = Date.now();
        this.graceUntil = Date.now() + (this.platform.isSafariMobile ? 5000 : 3000);
        this._timer = setInterval(() => this._tick(), this.checkMs);
        this._startFrameWatch();
        this._bindVisibility();
        startAutoplayRetryLoop();
        console.log("[any-remote] Safari render monitor on");
    }

    stop() {
        this._enabled = false;
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        this._rvfActive = false;
        this.recovering = false;
    }

    _bindVisibility() {
        if (this._visibilityBound) return;
        this._visibilityBound = true;

        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                console.log("[any-remote] page hidden");
                return;
            }
            if (this._enabled) this.onForeground();
        });
        window.addEventListener("pageshow", (e) => {
            if (this._enabled) this.onForeground();
        });
        window.addEventListener("pagehide", () => {
            console.log("[any-remote] page hide");
        });
    }

    _setHealth(h) {
        this.health = h;
        this.hooks.onHud?.({ videoHealth: h });
    }

    _startFrameWatch() {
        const v = this.video;
        const onFrame = (now) => {
            if (!this._enabled) return;
            this.fpsFrames++;
            this.framesDecoded++;
            const ct = v.currentTime;
            if (ct > this.lastCurrentTime + 0.0005) {
                this.lastCurrentTime = ct;
                this.lastAdvanceWallMs = Date.now();
            }
            if (now - this.fpsWindowStart >= 1000) {
                const fps = this.fpsFrames;
                this.fpsFrames = 0;
                this.fpsWindowStart = now;
                this.hooks.onFps?.(fps);
                this._pushWatchdog(this.sample());
            }
            if (this._enabled && this._rvfActive) {
                if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
                else requestAnimationFrame(onFrame);
            }
        };
        this._rvfActive = true;
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
        else requestAnimationFrame(onFrame);
    }

    _tick() {
        if (!this._enabled || this.recovering || Date.now() < this.graceUntil) return;
        const sample = this.sample();
        if (!sample) return;
        this._pushWatchdog(sample);

        const { frozen, black, reasons } = this.analyze(sample);
        if (!frozen && !black) return;

        console.warn("[any-remote] render freeze", reasons.join(", "));
        this._setHealth(black ? "black" : "frozen");
        this._renderRecover(reasons[0] || "tick");
    }

    async _renderRecover(tag) {
        if (this.recovering || !this._enabled) return;
        this.recovering = true;
        this._setHealth("recovering");
        console.log("[any-remote] render recover (no page reload)", tag);

        try {
            const track = this.getVideoTrack();
            if (track) {
                track.enabled = true;
                attachTrackToStableStream(track);
            }
            const stream = getStableMediaStream();
            const v = this.video;
            applyInlinePlaybackFlags(v);

            if (v.srcObject !== stream) {
                v.srcObject = stream;
            }

            try {
                v.load();
            } catch (_) {}

            await new Promise((r) => requestAnimationFrame(r));
            await forcePlayVideo();
            startAutoplayRetryLoop();

            if (this.hooks.requestKeyframe) this.hooks.requestKeyframe();

            this.lastAdvanceWallMs = Date.now();
            this.freezeDetected = false;
            this._setHealth("ok");
        } catch (err) {
            console.error("[any-remote] render recover failed", err);
            if (this.allowPeerHardRecover && this.hooks.onHardRecover) {
                this.hooks.onHardRecover();
            }
        } finally {
            this.recovering = false;
        }
    }

    async onForeground() {
        if (!this._enabled) return;
        console.log("[any-remote] foreground render recover");
        await this._renderRecover("foreground");
    }

    onNewSession() {
        this.freezeDetected = false;
        this.lastCurrentTime = -1;
        this.lastAdvanceWallMs = Date.now();
        this._setHealth("starting");
    }
}
