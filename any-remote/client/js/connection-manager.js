/**
 * WebRTC connection manager — signaling, ICE, media, input channel.
 * State machine: idle → connecting → connected → reconnecting → failed
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
        this.statsTimer = null;
        this.connecting = false;
        this.lastConnectAt = 0;
        this.state = "idle";
        this.onInputReady = null;
        this.onMeta = null;
        this.onState = null;
        this.iceConfig = null;
        this.relayOnly = false;
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
            this.send({ t: "quality", mode: this.quality.effectiveQuality(this.quality.mode) });
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
        this.reconnectAttempts++;
        const delay = this._backoffMs();
        console.log("[any-remote] reconnect", this.reconnectAttempts, "in", delay);
        this._setState("reconnecting");
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.sessionActive) this.connect();
        }, delay);
    }

    _cleanup() {
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.disconnectTimer);
        clearInterval(this.statsTimer);
        this.reconnectTimer = null;
        this.disconnectTimer = null;
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
        const video = document.getElementById("video");
        if (video) video.srcObject = null;
        this.hud.update({ dcState: "closed", connState: "closed", iceConnState: "closed" });
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
                this._scheduleReconnect();
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
                this._setState("connected");
                this.hud.markConnected();
                document.body.classList.add("session-live");
                this.refreshInputReady();
            } else if (pc.connectionState === "failed") {
                document.body.classList.remove("session-live");
                this._scheduleReconnect();
            } else if (pc.connectionState === "disconnected") {
                const delay = this.platform.isSafariMobile ? 6000 : 3000;
                this.disconnectTimer = setTimeout(() => {
                    if (
                        this.pc?.connectionState === "disconnected" &&
                        this.sessionActive
                    ) {
                        this._scheduleReconnect();
                    }
                }, delay);
            }
        });

        pc.addEventListener("track", (evt) => {
            if (evt.track.kind !== "video") return;
            attachVideoTrack(evt, document.getElementById("video"), () =>
                this.renderer.apply(),
            );
        });
    }

    _setupDc(channel) {
        this.dc = channel;
        this.hud.update({ dcState: channel.readyState });
        channel.addEventListener("open", () => {
            this.hud.update({ dcState: "open" });
            console.log("[any-remote] DataChannel open");
            this.refreshInputReady();
        });
        channel.addEventListener("close", () => {
            this.hud.update({ dcState: "closed" });
            console.log("[any-remote] DataChannel close");
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

    async connect() {
        const now = Date.now();
        if (this.connecting || now - this.lastConnectAt < CONNECT_DEBOUNCE_MS) return;
        this.connecting = true;
        this.lastConnectAt = now;
        this._cleanup();
        this._setState("connecting");
        this.hud.markIceStart();

        try {
            this.iceConfig = await fetchIceConfig(this.platform);
            this.relayOnly = this.iceConfig.iceTransportPolicy === "relay";
            console.log(
                "[any-remote] ICE policy",
                this.iceConfig.iceTransportPolicy,
                "safari=",
                this.platform.isSafariMobile,
                clientMeta(this.platform),
            );

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
            await waitForIceGathering(pc, this.platform);

            const sdp = filterSdpCandidates(
                pc.localDescription.sdp,
                this.relayOnly,
            );
            console.log("[any-remote] offer ICE", countSdpCandidates(sdp));

            const body = {
                sdp,
                type: pc.localDescription.type,
                quality: this.quality.effectiveQuality(
                    document.getElementById("quality-select")?.value || "balanced",
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
            answer.sdp = filterSdpCandidates(answer.sdp, answer.relayOnly);
            console.log("[any-remote] answer ICE", countSdpCandidates(answer.sdp));
            this.hud.update({ codec: answer.codec || "—" });
            await pc.setRemoteDescription(answer);

            this.statsTimer = setInterval(() => {
                this.hud.poll(this.pc);
                this.refreshInputReady();
            }, 1500);
        } catch (err) {
            console.error("[any-remote] connect error", err);
            this._scheduleReconnect();
        } finally {
            this.connecting = false;
        }
    }

    start() {
        this.sessionActive = true;
        this.reconnectAttempts = 0;
        return this.connect();
    }

    stop() {
        this.sessionActive = false;
        this._setState("idle");
        document.body.classList.remove("session-live");
        this._cleanup();
    }
}
