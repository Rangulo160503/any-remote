/**
 * Video freeze detection + escalating recovery (Safari long-session stability).
 * Desktop: lighter thresholds, same recovery ladder, less aggressive hard reconnect.
 */

import { configureLowLatencyReceiver, playVideoElement } from "./safari-compat.js";

const HAVE_CURRENT_DATA = 2;

export class VideoRecoveryMonitor {
    /**
     * @param {object} platform from detectPlatform()
     * @param {object} hooks
     * @param {() => boolean} hooks.isSessionLive
     * @param {() => boolean} hooks.isPeerConnected
     * @param {() => void} [hooks.requestKeyframe]
     * @param {() => void} [hooks.onHardRecover]
     * @param {(partial: object) => void} [hooks.onHud]
     * @param {(fps: number) => void} [hooks.onFps]
     */
    constructor(platform, hooks) {
        this.platform = platform;
        this.hooks = hooks;
        this.video = document.getElementById("video");
        this.receiver = null;
        this.track = null;

        const sm = platform.isSafariMobile;
        this.freezeMs = sm ? 2200 : 4000;
        this.blackMs = sm ? 3500 : 7000;
        this.checkMs = sm ? 450 : 900;
        this.maxSoftBeforeRefresh = sm ? 2 : 4;
        this.maxRefreshBeforeKeyframe = sm ? 2 : 3;
        this.maxKeyframeBeforeHard = sm ? 2 : 4;
        this.hardCooldownMs = sm ? 45000 : 90000;

        this.lastCurrentTime = -1;
        this.lastFrameWallMs = 0;
        this.lastAdvanceWallMs = 0;
        this.stallTicks = 0;
        this.softAttempts = 0;
        this.refreshAttempts = 0;
        this.keyframeAttempts = 0;
        this.hardAttempts = 0;
        this.lastHardAt = 0;
        this.recovering = false;
        this.fpsFrames = 0;
        this.fpsWindowStart = performance.now();
        this.health = "idle";
        this._timer = null;
        this._rvfActive = false;
        this._enabled = false;
        this.graceUntil = 0;
    }

    getVideoTrack() {
        const stream = this.video?.srcObject;
        if (stream?.getVideoTracks?.().length) return stream.getVideoTracks()[0];
        return this.track || null;
    }

    sample() {
        const v = this.video;
        const track = this.getVideoTrack();
        if (!v) return null;

        return {
            currentTime: v.currentTime,
            readyState: v.readyState,
            paused: v.paused,
            ended: v.ended,
            networkState: v.networkState,
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
            trackMuted: track?.muted ?? null,
            trackEnabled: track?.enabled ?? null,
            trackReadyState: track?.readyState ?? null,
            streamActive: v.srcObject?.active ?? null,
            streamId: v.srcObject?.id ?? null,
        };
    }

    /**
     * @returns {{ frozen: boolean, black: boolean, reasons: string[] }}
     */
    analyze(sample) {
        const reasons = [];
        const now = Date.now();
        const peerUp = this.hooks.isPeerConnected?.() ?? false;
        const live = this.hooks.isSessionLive?.() ?? false;

        if (!live || !peerUp || !this.video?.srcObject) {
            return { frozen: false, black: false, reasons: ["no-session"] };
        }

        const ct = sample.currentTime;
        const advanced =
            this.lastCurrentTime >= 0 &&
            ct > this.lastCurrentTime + 0.001;
        if (advanced) {
            this.lastAdvanceWallMs = now;
            this.lastCurrentTime = ct;
            this.stallTicks = 0;
        } else if (this.lastCurrentTime >= 0 && ct === this.lastCurrentTime) {
            this.stallTicks++;
            if (now - this.lastAdvanceWallMs > this.freezeMs) {
                reasons.push("currentTime-stalled");
            }
        } else {
            this.lastCurrentTime = ct;
            this.lastAdvanceWallMs = now;
        }

        if (sample.paused && !sample.ended) reasons.push("video-paused");
        if (sample.ended) reasons.push("video-ended");
        if (sample.readyState < HAVE_CURRENT_DATA && peerUp) {
            reasons.push(`readyState-${sample.readyState}`);
        }
        if (sample.networkState === 3) reasons.push("network-empty");

        if (sample.trackReadyState === "ended") reasons.push("track-ended");
        if (sample.trackMuted) reasons.push("track-muted");
        if (sample.trackEnabled === false) reasons.push("track-disabled");
        if (sample.streamActive === false) reasons.push("stream-inactive");

        const noPicture =
            peerUp &&
            (sample.videoWidth === 0 || sample.videoHeight === 0) &&
            now - this.lastAdvanceWallMs > this.blackMs;
        if (noPicture) reasons.push("black-no-dimensions");

        const wallStall = now - this.lastAdvanceWallMs > this.freezeMs && peerUp;
        const frozen =
            reasons.length > 0 &&
            (wallStall ||
                reasons.includes("video-paused") ||
                reasons.includes("track-ended") ||
                reasons.includes("stream-inactive"));

        return {
            frozen,
            black: noPicture || reasons.includes("black-no-dimensions"),
            reasons,
        };
    }

    bindTrack(evt) {
        this.receiver = evt.receiver ?? null;
        this.track = evt.track ?? null;
        this.lastCurrentTime = -1;
        this.lastAdvanceWallMs = Date.now();
        this.stallTicks = 0;
        this.health = "starting";

        if (this.track) {
            this.track.enabled = true;
            this.track.onmute = () => {
                console.warn("[any-remote] video track muted");
                this._scheduleRecover("track-mute");
            };
            this.track.onunmute = () => {
                console.log("[any-remote] video track unmuted");
                this._runSoftRecover("track-unmute");
            };
            this.track.onended = () => {
                console.warn("[any-remote] video track ended");
                this._scheduleRecover("track-ended");
            };
        }
        configureLowLatencyReceiver(this.receiver);
        this._setHealth("ok");
    }

    clearMedia() {
        this.stop();
        this.receiver = null;
        this.track = null;
        this.lastCurrentTime = -1;
        if (this.video) this.video.srcObject = null;
        this._setHealth("idle");
    }

    start() {
        this.stop();
        this._enabled = true;
        this.lastAdvanceWallMs = Date.now();
        this.graceUntil =
            Date.now() + (this.platform.isSafariMobile ? 6000 : 3500);
        this._timer = setInterval(() => this._tick(), this.checkMs);
        this._startFrameWatch();
        console.log(
            "[any-remote] video monitor start",
            "freezeMs=" + this.freezeMs,
            "safari=" + this.platform.isSafariMobile,
        );
    }

    stop() {
        this._enabled = false;
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        this._rvfActive = false;
        this.recovering = false;
    }

    _setHealth(h) {
        this.health = h;
        this.hooks.onHud?.({ videoHealth: h });
    }

    _startFrameWatch() {
        const v = this.video;
        if (!v) return;

        const onFrame = (now) => {
            if (!this._enabled) return;
            this.fpsFrames++;
            const ct = v.currentTime;
            if (this.lastCurrentTime < 0 || ct > this.lastCurrentTime + 0.0005) {
                this.lastCurrentTime = ct;
                this.lastAdvanceWallMs = Date.now();
                this.lastFrameWallMs = Date.now();
            }
            if (now - this.fpsWindowStart >= 1000) {
                const fps = this.fpsFrames;
                this.fpsFrames = 0;
                this.fpsWindowStart = now;
                this.hooks.onFps?.(fps);
                if (fps > 0) this._setHealth("ok");
            }
            if (this._enabled && this._rvfActive) {
                if (v.requestVideoFrameCallback) {
                    v.requestVideoFrameCallback(onFrame);
                } else {
                    requestAnimationFrame(onFrame);
                }
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

        const { frozen, black, reasons } = this.analyze(sample);
        if (!frozen && !black) return;

        console.warn("[any-remote] video freeze detected", reasons.join(", "), sample);
        this._setHealth(black ? "black" : "frozen");
        this._escalateRecover(black, reasons);
    }

    _scheduleRecover(reason) {
        if (this.recovering) return;
        setTimeout(() => {
            if (this._enabled) this._escalateRecover(false, [reason]);
        }, 80);
    }

    async _escalateRecover(isBlack, reasons) {
        if (this.recovering || !this._enabled) return;
        const now = Date.now();
        if (now - this.lastHardAt < this.hardCooldownMs && this.hardAttempts > 0) {
            await this._runSoftRecover("cooldown-soft");
            return;
        }

        this.recovering = true;
        this._setHealth("recovering");

        try {
            if (this.softAttempts < this.maxSoftBeforeRefresh) {
                this.softAttempts++;
                await this._runSoftRecover(reasons[0] || "stall");
                return;
            }

            if (this.refreshAttempts < this.maxRefreshBeforeKeyframe) {
                this.refreshAttempts++;
                await this._runRefreshStream();
                return;
            }

            if (
                this.keyframeAttempts < this.maxKeyframeBeforeHard &&
                this.hooks.requestKeyframe
            ) {
                this.keyframeAttempts++;
                this.hooks.requestKeyframe();
                await this._runSoftRecover("after-keyframe");
                return;
            }

            if (isBlack || this.hardAttempts < 3) {
                this.hardAttempts++;
                this.lastHardAt = now;
                console.warn("[any-remote] video hard recover", reasons);
                this._setHealth("hard");
                this.hooks.onHardRecover?.();
                this.softAttempts = 0;
                this.refreshAttempts = 0;
                this.keyframeAttempts = 0;
                return;
            }

            await this._runSoftRecover("max-escalation");
        } finally {
            this.recovering = false;
        }
    }

    async _runSoftRecover(tag) {
        console.log("[any-remote] video soft recover", tag);
        const track = this.getVideoTrack();
        if (track) {
            track.enabled = true;
        }
        configureLowLatencyReceiver(this.receiver);
        await playVideoElement(this.video);
        this.lastAdvanceWallMs = Date.now();
        this._setHealth("ok");
    }

    async _runRefreshStream() {
        console.log("[any-remote] video refresh stream");
        const track = this.getVideoTrack();
        if (!track) {
            await this._runSoftRecover("no-track");
            return;
        }
        const stream = new MediaStream();
        stream.addTrack(track);
        const v = this.video;
        v.srcObject = null;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        v.srcObject = stream;
        v.load?.();
        await playVideoElement(v);
        this.lastCurrentTime = -1;
        this.lastAdvanceWallMs = Date.now();
        this._setHealth("ok");
    }

    /** Called when tab becomes visible or page restored from bfcache. */
    async onForeground() {
        if (!this._enabled) return;
        console.log("[any-remote] video foreground recover");
        this.softAttempts = 0;
        await this._runRefreshStream();
        await this._runSoftRecover("foreground");
        if (this.hooks.isPeerConnected?.() && this.hooks.requestKeyframe) {
            this.hooks.requestKeyframe();
        }
    }

    /** Reset counters after successful full reconnect. */
    onNewSession() {
        this.softAttempts = 0;
        this.refreshAttempts = 0;
        this.keyframeAttempts = 0;
        this.hardAttempts = 0;
        this.lastCurrentTime = -1;
        this.lastAdvanceWallMs = Date.now();
        this._setHealth("starting");
    }
}
