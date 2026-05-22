/**
 * WebRTC — fast connect, peer-only reconnect, ICE discipline.
 */

import {
    buildRtcConfiguration,
    countSdpCandidates,
    fetchIceConfig,
    filterSdpCandidates,
    waitForIceGathering,
} from "./ice-policy.js";
import { logLocalCandidate } from "./ice-diag.js";
import { preferReceiverH264, attachVideoTrack } from "./safari-compat.js";
import { getClientId, clientMeta } from "./platform.js";
import { VideoRecoveryMonitor } from "./video-recovery.js";
import { mungeSdpForSafariMobile } from "./sdp-munge.js";
import { stopAutoplayRetryLoop, forcePlayVideo } from "./video-singleton.js";
import { FastConnect, CONNECT_BUDGET_MS, ICE_DISCONNECT_MS } from "./fast-connect.js";

const MAX_RECONNECT = 5;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const CONNECT_DEBOUNCE_MS = 800;

export class ConnectionManager {
    constructor(platform, hud, renderer, quality) {
        this.platform = platform;
        this.hud = hud;
        this.renderer = renderer;
        this.quality = quality;
        this.pc = null;
        this.dc = null;
        this.dcQueue = [];
        this.inputReady = false;
        this.sessionActive = false;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.disconnectTimer = null;
        this.iceFailTimer = null;
        this.statsTimer = null;
        this.connecting = false;
        this.lastConnectAt = 0;
        this.state = "idle";
        this.onInputReady = null;
        this.onMeta = null;
        this.onState = null;
        this.onFirstFrame = null;
        this.iceConfig = null;
        this.relayOnly = false;

        this.fastConnect = new FastConnect({
            onFirstFrame: () => this._handleFirstFrame(),
        });

        this.videoMonitor = new VideoRecoveryMonitor(platform, {
            isSessionLive: () => this.sessionActive,
            isPeerConnected: () =>
                this.pc?.connectionState === "connected" && this.isIceConnected(),
            inStartup: () => this.fastConnect.inStartup,
            onFirstFrame: () => this.fastConnect.notifyFirstFrame(),
            requestKeyframe: () => {
                if (this.dc?.readyState === "open") {
                    this.dc.send(JSON.stringify({ t: "keyframe" }));
                }
            },
            onHardRecover: () => this._peerOnlyReconnect(),
            onHud: (p) => this.hud.update(p),
            onFps: (fps) => this.hud.update({ fps }),
            onWatchdog: (s) => this.hud.updateWatchdog(s),
        });
    }

    _handleFirstFrame() {
        document.getElementById("connect-splash")?.classList.add("hidden");
        stopAutoplayRetryLoop();
        forcePlayVideo();
        this.reconnectAttempts = 0;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.onFirstFrame?.();
        if (this.fastConnect.markStablePlayback()) {
            this.quality.onStableRamp();
        }
    }

    _peerOnlyReconnect() {
        if (!this.sessionActive) return;
        console.warn("[any-remote] peer-only reconnect");
        this.videoMonitor.stop();
        this.renderer.detachVideo();
        this.fastConnect.markConnectStart();
        this.reconnectAttempts = Math.max(0, this.reconnectAttempts - 1);
        this.connect();
    }

    _setState(s) {
        this.state = s;
        this.onState?.(s);
    }

    isIceConnected() {
        if (!this.pc) return false;
        const ice = this.pc.iceConnectionState;
        return ice === "connected" || ice === "completed";
    }

    canSendInput() {
        return (
            this.inputReady &&
            this.dc?.readyState === "open" &&
            this.pc?.connectionState === "connected" &&
            this.isIceConnected()
        );
    }

    refreshInputReady() {
        const ready =
            this.pc?.connectionState === "connected" &&
            this.isIceConnected() &&
            this.dc?.readyState === "open";
        if (ready && !this.inputReady) {
            this.inputReady = true;
            this._flushDcQueue();
            this.send({
                t: "quality",
                mode: this.quality.effectiveQuality(
                    document.getElementById("quality-select")?.value || "balanced",
                ),
            });
            this.onInputReady?.();
        } else if (!ready) {
            this.inputReady = false;
        }
    }

    send(event) {
        const payload = JSON.stringify(event);
        if (!this.dc) return;
        if (this.dc.readyState === "open" && this.canSendInput()) {
            this.dc.send(payload);
            return;
        }
        if (this.dc.readyState === "connecting" || this.dc.readyState === "open") {
            this.dcQueue.push(payload);
        }
    }

    _flushDcQueue() {
        if (!this.dc || this.dc.readyState !== "open") return;
        while (this.dcQueue.length) this.dc.send(this.dcQueue.shift());
    }

    _backoffMs() {
        return Math.min(
            RECONNECT_MAX_MS,
            RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
        );
    }

    _scheduleReconnect() {
        if (!this.sessionActive || this.reconnectAttempts >= MAX_RECONNECT) {
            this._setState("failed");
            return;
        }
        if (this.pc?.connectionState === "connected") return;
        this.reconnectAttempts++;
        const delay = this._backoffMs();
        console.log("[any-remote] peer reconnect", this.reconnectAttempts, "in", delay);
        this._setState("reconnecting");
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.sessionActive && this.pc?.connectionState !== "connected") {
                this.connect();
            }
        }, delay);
    }

    _scheduleDelayedReconnect(delayMs, reason) {
        clearTimeout(this.iceFailTimer);
        clearTimeout(this.disconnectTimer);
        this.iceFailTimer = setTimeout(() => {
            this.iceFailTimer = null;
            if (
                !this.sessionActive ||
                this.pc?.connectionState === "connected"
            ) {
                return;
            }
            console.log("[any-remote] reconnect after", reason);
            this._scheduleReconnect();
        }, delayMs);
    }

    _cleanupPeerOnly() {
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.disconnectTimer);
        clearTimeout(this.iceFailTimer);
        clearInterval(this.statsTimer);
        this.reconnectTimer = null;
        this.disconnectTimer = null;
        this.iceFailTimer = null;
        this.statsTimer = null;
        this.inputReady = false;
        if (this.dc) {
            try {
                this.dc.close();
            } catch (_) {}
            this.dc = null;
        }
        this.dcQueue.length = 0;
        if (this.pc) {
            try {
                this.pc.close();
            } catch (_) {}
            this.pc = null;
        }
        this.videoMonitor.stop();
        this.renderer.detachVideo();
        this.hud.update({
            dcState: "closed",
            connState: "closed",
            iceConnState: "closed",
        });
    }

    _wirePc(pc) {
        pc.addEventListener("icecandidate", (ev) => {
            if (ev.candidate) logLocalCandidate(ev.candidate);
        });

        pc.addEventListener("iceconnectionstatechange", () => {
            this.hud.update({ iceConnState: pc.iceConnectionState });
            console.log("[any-remote] iceConnectionState", pc.iceConnectionState);
            this.refreshInputReady();
            if (pc.iceConnectionState === "failed" && this.sessionActive) {
                if (pc.connectionState === "connected") {
                    console.log("[any-remote] ICE failed but DTLS up — no ICE restart");
                    return;
                }
                this._scheduleDelayedReconnect(ICE_DISCONNECT_MS, "ice-failed");
            }
        });

        pc.addEventListener("connectionstatechange", () => {
            this.hud.update({ connState: pc.connectionState });
            console.log(
                "[any-remote] connectionState",
                pc.connectionState,
                "ice=",
                pc.iceConnectionState,
            );
            clearTimeout(this.disconnectTimer);
            if (pc.connectionState === "connected") {
                this.reconnectAttempts = 0;
                clearTimeout(this.iceFailTimer);
                this._setState("connected");
                this.hud.markConnected();
                document.body.classList.add("session-live");
                this.refreshInputReady();
            } else if (pc.connectionState === "failed") {
                document.body.classList.remove("session-live");
                this._scheduleDelayedReconnect(ICE_DISCONNECT_MS, "conn-failed");
            } else if (pc.connectionState === "disconnected") {
                this._scheduleDelayedReconnect(ICE_DISCONNECT_MS, "disconnected");
            }
        });

        pc.addEventListener("track", (evt) => {
            if (evt.track.kind !== "video") return;
            attachVideoTrack(
                evt,
                this.renderer.video,
                () => this.renderer.apply(),
                this.videoMonitor,
            );
            this.videoMonitor.onNewSession();
        });
    }

    _setupDc(channel) {
        this.dc = channel;
        this.hud.update({ dcState: channel.readyState });
        channel.addEventListener("open", () => {
            this.hud.update({ dcState: "open" });
            this.refreshInputReady();
        });
        channel.addEventListener("close", () => {
            this.hud.update({ dcState: "closed" });
        });
        channel.addEventListener("message", (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                if (msg.t === "meta") {
                    this.onMeta?.(msg);
                    this.hud.update({ codec: msg.codec || "—", quality: msg.quality });
                }
            } catch (_) {}
        });
    }

    _mungeSdp(sdp) {
        let out = filterSdpCandidates(sdp, this.relayOnly);
        out = mungeSdpForSafariMobile(out, this.platform);
        return out;
    }

    async _doConnect() {
        this.iceConfig = await fetchIceConfig(this.platform);
        this.relayOnly = this.iceConfig.iceTransportPolicy === "relay";

        const pc = new RTCPeerConnection(
            buildRtcConfiguration(this.iceConfig, this.platform),
        );
        this.pc = pc;
        this._wirePc(pc);
        pc.addTransceiver("video", { direction: "recvonly" });
        preferReceiverH264(pc, this.platform);

        const dcOpts = this.platform.ios
            ? { ordered: false, maxRetransmits: 0 }
            : { ordered: true };
        this._setupDc(pc.createDataChannel("input", dcOpts));

        await pc.setLocalDescription(await pc.createOffer());
        await waitForIceGathering(pc, this.platform, true);

        const sdp = this._mungeSdp(pc.localDescription.sdp);
        console.log("[any-remote] offer ICE", countSdpCandidates(sdp));

        const body = {
            sdp,
            type: pc.localDescription.type,
            quality: this.quality.effectiveQuality(
                document.getElementById("quality-select")?.value || "mobile",
            ),
            mobile: this.platform.mobile,
            safari: this.platform.safari,
            ios: this.platform.ios,
            forceRelay: this.relayOnly,
            clientId: getClientId(),
            clientMeta: {
                ...clientMeta(this.platform),
                iceTransportPolicy: this.iceConfig.iceTransportPolicy,
            },
        };

        const r = await fetch("/offer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error("signaling " + r.status);
        const answer = await r.json();
        answer.sdp = this._mungeSdp(answer.sdp);
        await pc.setRemoteDescription(answer);
        this.hud.update({ codec: answer.codec || "—" });

        this.statsTimer = setInterval(() => {
            this.hud.poll(this.pc);
            this.refreshInputReady();
            if (this.fastConnect.firstFrameReceived && this.fastConnect.markStablePlayback()) {
                this.quality.onStableRamp();
            }
        }, 1500);
    }

    async connect() {
        const now = Date.now();
        if (this.connecting || now - this.lastConnectAt < CONNECT_DEBOUNCE_MS) return;
        this.connecting = true;
        this.lastConnectAt = now;
        this.fastConnect.markConnectStart();
        this.videoMonitor.stop();
        this._cleanupPeerOnly();
        this._setState("connecting");
        this.hud.markIceStart();

        const budget = new Promise((_, reject) =>
            setTimeout(
                () => reject(new Error("connect budget exceeded")),
                CONNECT_BUDGET_MS,
            ),
        );

        try {
            await Promise.race([this._doConnect(), budget]);
        } catch (err) {
            console.error("[any-remote] connect error", err);
            if (!this.fastConnect.firstFrameReceived) {
                this._scheduleReconnect();
            }
        } finally {
            this.connecting = false;
        }
    }

    start() {
        this.sessionActive = true;
        this.reconnectAttempts = 0;
        this.quality.onFirstFrame();
        return this.connect();
    }

    stop() {
        this.sessionActive = false;
        this._setState("idle");
        document.body.classList.remove("session-live");
        stopAutoplayRetryLoop();
        this._cleanupPeerOnly();
        this.videoMonitor.clearMedia();
        this.quality.stablePlayback = false;
        this.quality.rampStage = 0;
    }
}
