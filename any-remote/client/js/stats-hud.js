/** Connection HUD + ICE diagnostics. */

import { formatPairSummary } from "./ice-diag.js";

export class StatsHUD {
    constructor() {
        this.data = {
            connState: "new",
            iceConnState: "new",
            dcState: "closed",
            codec: "—",
            fps: 0,
            relay: false,
            localCandType: "—",
            remoteCandType: "—",
            selectedPair: "—",
            protocol: "—",
            rttMs: null,
            bitrateKbps: null,
            packetLoss: null,
            quality: "balanced",
            iceDurationMs: null,
            videoHealth: "idle",
        };
        this.iceStartedAt = null;
        this.els = {
            conn: document.getElementById("info-conn"),
            hud: document.getElementById("hud-panel"),
            coords: document.getElementById("info-coords"),
            stream: document.getElementById("info-stream"),
        };
    }

    setQuality(q) {
        this.data.quality = q;
        this.render();
    }

    markIceStart() {
        this.iceStartedAt = performance.now();
    }

    markConnected() {
        if (this.iceStartedAt) {
            this.data.iceDurationMs = Math.round(performance.now() - this.iceStartedAt);
        }
    }

    update(partial) {
        Object.assign(this.data, partial);
        this.render();
    }

    render() {
        const d = this.data;
        const path = d.relay ? "relay" : `${d.localCandType}↔${d.remoteCandType}`;
        const live = d.connState === "connected";
        if (this.els.conn) {
            this.els.conn.textContent = [
                live ? "ok" : d.connState,
                `ice:${d.iceConnState}`,
                d.selectedPair !== "—" ? d.selectedPair : path,
                `dc:${d.dcState}`,
                d.codec,
                `${d.fps}fps`,
                `vid:${d.videoHealth}`,
            ].join(" · ");
        }
        if (this.els.hud) {
            this.els.hud.innerHTML = `
                <span>${live ? "●" : "○"} ${d.connState}</span>
                <span>ICE ${d.iceConnState}</span>
                <span>${d.selectedPair}</span>
                <span>video ${d.videoHealth}</span>
                <span>${d.fps} fps</span>
                <span>RTT ${d.rttMs != null ? Math.round(d.rttMs) + "ms" : "—"}</span>
                <span>loss ${d.packetLoss != null ? (d.packetLoss * 100).toFixed(1) + "%" : "—"}</span>
                <span>${d.quality}</span>
            `;
        }
    }

    async poll(pc) {
        if (!pc) return;
        this.update({
            connState: pc.connectionState,
            iceConnState: pc.iceConnectionState,
        });
        try {
            const reports = await pc.getStats();
            let pair = null;
            const cands = new Map();
            let inbound = null;

            reports.forEach((r) => {
                if (r.type === "candidate-pair" && (r.selected || r.nominated)) pair = r;
                if (r.type === "local-candidate") cands.set(r.id, r);
                if (r.type === "remote-candidate") cands.set(r.id, r);
                if (r.type === "inbound-rtp" && r.kind === "video") inbound = r;
            });
            if (!pair) {
                reports.forEach((r) => {
                    if (r.type === "candidate-pair" && r.state === "succeeded") pair = r;
                });
            }
            if (pair) {
                const local = cands.get(pair.localCandidateId);
                const remote = cands.get(pair.remoteCandidateId);
                const lt = local?.candidateType || "—";
                const rt = remote?.candidateType || "—";
                const proto = local?.relayProtocol || local?.protocol || "udp";
                const summary = formatPairSummary(lt, rt, proto);
                console.log(
                    "[any-remote] selected_pair=" + summary,
                    "local=" + lt,
                    "remote=" + rt,
                    "protocol=" + proto,
                );
                this.update({
                    localCandType: lt,
                    remoteCandType: rt,
                    relay: lt === "relay" || rt === "relay",
                    selectedPair: summary,
                    protocol: proto,
                    rttMs: pair.currentRoundTripTime
                        ? pair.currentRoundTripTime * 1000
                        : null,
                });
            }
            if (inbound) {
                this.update({
                    bitrateKbps: inbound.bytesReceived
                        ? Math.round((inbound.bytesReceived * 8) / 1000)
                        : null,
                    packetLoss: inbound.packetsLost
                        ? inbound.packetsLost /
                          Math.max(1, inbound.packetsReceived + inbound.packetsLost)
                        : 0,
                });
            }
        } catch (err) {
            console.log("[any-remote] getStats", err.message);
        }
    }
}
