/** ICE servers + transport policy (relay-only on Safari mobile). */

import { detectPlatform } from "./platform.js";

const FALLBACK = [
    { urls: "stun:stun.relay.metered.ca:80" },
    {
        urls: "turn:standard.relay.metered.ca:80",
        username: "bd8989604d98ccf84f5bd12f",
        credential: "ZEq6ndSozfIK+IqK",
    },
    {
        urls: "turn:standard.relay.metered.ca:80?transport=tcp",
        username: "bd8989604d98ccf84f5bd12f",
        credential: "ZEq6ndSozfIK+IqK",
    },
    {
        urls: "turn:standard.relay.metered.ca:443",
        username: "bd8989604d98ccf84f5bd12f",
        credential: "ZEq6ndSozfIK+IqK",
    },
    {
        urls: "turns:standard.relay.metered.ca:443?transport=tcp",
        username: "bd8989604d98ccf84f5bd12f",
        credential: "ZEq6ndSozfIK+IqK",
    },
    {
        urls: "turns:standard.relay.metered.ca:443",
        username: "bd8989604d98ccf84f5bd12f",
        credential: "ZEq6ndSozfIK+IqK",
    },
];

let cache = null;

export function resolveIceTransportPolicy(platform) {
    if (platform.isSafariMobile) return "relay";
    return "all";
}

export async function fetchIceConfig(platform) {
    if (cache) return cache;
    const q = new URLSearchParams({
        mobile: platform.mobile ? "1" : "0",
        safari: platform.safari ? "1" : "0",
    });
    try {
        const r = await fetch(`/ice-config?${q}`);
        if (r.ok) {
            cache = await r.json();
            return cache;
        }
    } catch (_) {
        /* use fallback */
    }
    cache = {
        iceServers: FALLBACK,
        iceTransportPolicy: resolveIceTransportPolicy(platform),
    };
    return cache;
}

export function buildRtcConfiguration(iceBundle, platform) {
    const policy =
        iceBundle.iceTransportPolicy || resolveIceTransportPolicy(platform);
    const cfg = {
        iceServers: iceBundle.iceServers || FALLBACK,
        iceTransportPolicy: policy,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
    };
    if (platform.mobile) cfg.iceCandidatePoolSize = 4;
    if (!platform.ios) cfg.sdpSemantics = "unified-plan";
    return cfg;
}

const USABLE = new Set(["srflx", "relay", "prflx"]);

export function parseCandidateLine(line) {
    if (!line.startsWith("a=candidate:")) return null;
    const parts = line.slice(12).split(" ");
    const i = parts.indexOf("typ");
    if (i < 0) return null;
    return { ip: parts[4], typ: parts[i + 1], proto: parts[2] || "udp" };
}

export function filterSdpCandidates(sdp, relayOnly = false) {
    const lines = sdp.replace(/\r\n/g, "\n").split("\n").filter((line) => {
        if (!line.startsWith("a=candidate:")) return true;
        const p = parseCandidateLine(line);
        if (!p) return false;
        if (relayOnly) return p.typ === "relay";
        if (p.typ === "host") return false;
        if (USABLE.has(p.typ)) return true;
        return false;
    });
    let body = lines.join("\r\n");
    if (body && !body.endsWith("\r\n")) body += "\r\n";
    return body;
}

export function countSdpCandidates(sdp) {
    const c = { host: 0, srflx: 0, relay: 0, prflx: 0 };
    for (const line of sdp.replace(/\r\n/g, "\n").split("\n")) {
        const p = parseCandidateLine(line);
        if (p && c[p.typ] !== undefined) c[p.typ]++;
    }
    return c;
}

export function waitForIceGathering(pc, platform, startupPhase = false) {
    const ms = startupPhase
        ? 5000
        : platform.isSafariMobile
          ? 15000
          : platform.mobile
            ? 12000
            : 10000;
    return new Promise((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const done = () => {
            clearTimeout(timer);
            pc.removeEventListener("icegatheringstatechange", onCh);
            resolve();
        };
        const onCh = () => {
            if (pc.iceGatheringState === "complete") done();
        };
        const timer = setTimeout(done, ms);
        pc.addEventListener("icegatheringstatechange", onCh);
    });
}
