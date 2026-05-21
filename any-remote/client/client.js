/**
 * Any-Remote — desktop + mobile (iPhone Safari / Android Chrome).
 */

let pc = null;
let dc = null;
let lastMoveSent = 0;
let controlActive = false;
let hostMeta = null;
let sessionActive = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

let zoomLevel = 100;
let displayMode = "fit";
let qualityMode = "balanced";

const MOVE_INTERVAL_MS = 33;
const DRAG_MOVE_INTERVAL_MS = 16;
const ICE_GATHER_TIMEOUT_MS = 6000;
const MAX_RECONNECT = 3;
const DEBUG = true;

const BUTTON_NAMES = { 0: "left", 1: "middle", 2: "right" };

const dragState = { active: false, button: null };
const dcQueue = [];

const platform = detectPlatform();

/** Fallback if GET /ice-config fails (Metered STUN + TURN). */
const ICE_SERVERS_FALLBACK = [
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
];

let iceServersCache = null;
let statsPollTimer = null;
let inputReady = false;

async function fetchIceServers() {
    if (iceServersCache) return iceServersCache;
    try {
        const r = await fetch("/ice-config");
        if (r.ok) {
            const data = await r.json();
            iceServersCache = data.iceServers || ICE_SERVERS_FALLBACK;
            log("ICE servers loaded", iceServersCache.length);
            return iceServersCache;
        }
    } catch (err) {
        log("ICE config fetch failed", err.message || err);
    }
    iceServersCache = ICE_SERVERS_FALLBACK;
    return iceServersCache;
}

function buildPeerConnectionConfig(iceServers) {
    const cfg = {
        iceServers,
        iceTransportPolicy: "all",
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
    };
    if (platform.mobile) {
        cfg.iceCandidatePoolSize = 4;
    }
    if (!platform.ios) {
        cfg.sdpSemantics = "unified-plan";
    }
    return cfg;
}

const USABLE_CANDIDATE_TYPES = new Set(["srflx", "relay", "prflx"]);

const CODE_TO_KEY = {
    Space: "space",
    Enter: "enter",
    Backspace: "backspace",
    Escape: "esc",
    Tab: "tab",
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
    ShiftLeft: "shift",
    ShiftRight: "shift",
    ControlLeft: "ctrl",
    ControlRight: "ctrl",
    AltLeft: "alt",
    AltRight: "alt",
    MetaLeft: "command",
    MetaRight: "command",
};

const stats = {
    dcState: "closed",
    iceState: "new",
    iceConnState: "new",
    connState: "new",
    fps: 0,
    codec: "—",
    relay: false,
    localCandType: "—",
    remoteCandType: "—",
    lastCoords: null,
};

let disconnectTimer = null;

function detectPlatform() {
    const ua = navigator.userAgent || "";
    const ios = /iPhone|iPad|iPod/i.test(ua);
    const android = /Android/i.test(ua);
    const safari = ios || (/Safari/i.test(ua) && !/Chrome|CriOS|FxiOS/i.test(ua));
    const mobile =
        ios ||
        android ||
        (navigator.maxTouchPoints > 0 && window.matchMedia("(max-width: 900px)").matches);
    return { mobile, safari, ios, android };
}

function log(...args) {
    if (DEBUG) console.log("[any-remote]", ...args);
}

function initMobileDefaults() {
    if (!platform.mobile) return;
    qualityMode = "mobile";
    const sel = document.getElementById("quality-select");
    if (sel) sel.value = "mobile";
    document.body.classList.add("is-mobile");
    if (platform.safari) document.body.classList.add("is-safari");
    log("mobile defaults", platform, "quality", qualityMode);
}

function setStatus(text, live) {
    document.getElementById("status-text").textContent = text;
    document.getElementById("status-dot").classList.toggle("live", !!live);
}

function updateToolbarInfo(coords) {
    const video = document.getElementById("video");
    const coordsEl = document.getElementById("info-coords");
    const streamEl = document.getElementById("info-stream");
    const connEl = document.getElementById("info-conn");

    if (coords) stats.lastCoords = coords;
    const drag = dragState.active ? ` drag:${dragState.button}` : "";
    const xy = coords
        ? `${(coords.x * 100).toFixed(0)}% ${(coords.y * 100).toFixed(0)}%`
        : "—";
    coordsEl.textContent = `${xy}${drag}`;

    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    streamEl.textContent = vw > 0 ? `${vw}×${vh}` : "—";

    const path =
        stats.relay || stats.localCandType === "relay" || stats.remoteCandType === "relay"
            ? "relay"
            : stats.localCandType !== "—"
              ? `${stats.localCandType}↔${stats.remoteCandType}`
              : "—";
    const live = stats.connState === "connected" && isIceConnected();
    connEl.textContent = `${live ? "ok" : stats.connState} · ice:${stats.iceConnState} · ${path} · dc:${stats.dcState} · ${stats.codec} · ${stats.fps}fps`;
}

function isIceConnected() {
    if (!pc) return false;
    const ice = pc.iceConnectionState;
    return ice === "connected" || ice === "completed";
}

function canSendInput() {
    return (
        inputReady &&
        dc &&
        dc.readyState === "open" &&
        pc &&
        pc.connectionState === "connected" &&
        isIceConnected()
    );
}

function refreshInputReady() {
    const ready =
        pc &&
        pc.connectionState === "connected" &&
        isIceConnected() &&
        dc &&
        dc.readyState === "open";
    if (ready && !inputReady) {
        inputReady = true;
        log("input ready (ICE + connection + DataChannel)");
        flushDcQueue();
        sendWhenDcOpen({ t: "quality", mode: effectiveQuality() });
    } else if (!ready) {
        inputReady = false;
    }
    updateToolbarInfo(stats.lastCoords);
}

async function refreshConnectionStats() {
    if (!pc) return;
    stats.connState = pc.connectionState;
    stats.iceConnState = pc.iceConnectionState;

    try {
        const reports = await pc.getStats();
        let pair = null;
        const cands = new Map();

        reports.forEach((r) => {
            if (r.type === "candidate-pair" && (r.selected || r.nominated)) {
                pair = r;
            }
            if (r.type === "local-candidate") cands.set(r.id, r);
            if (r.type === "remote-candidate") cands.set(r.id, r);
        });

        if (!pair) {
            reports.forEach((r) => {
                if (r.type === "candidate-pair" && r.state === "succeeded") pair = r;
            });
        }

        if (pair) {
            const local = cands.get(pair.localCandidateId);
            const remote = cands.get(pair.remoteCandidateId);
            stats.localCandType = local?.candidateType || "—";
            stats.remoteCandType = remote?.candidateType || "—";
            stats.relay =
                stats.localCandType === "relay" || stats.remoteCandType === "relay";
            log(
                "ICE pair",
                stats.localCandType,
                "↔",
                stats.remoteCandType,
                "relay=",
                stats.relay,
            );
        }
    } catch (err) {
        log("getStats failed", err.message || err);
    }

    refreshInputReady();
}

function startStatsPoll() {
    stopStatsPoll();
    refreshConnectionStats();
    statsPollTimer = setInterval(refreshConnectionStats, 1500);
}

function stopStatsPoll() {
    if (statsPollTimer) {
        clearInterval(statsPollTimer);
        statsPollTimer = null;
    }
}

function logLocalIceCandidate(candidate) {
    const parsed = parseCandidate("a=candidate:" + candidate.candidate);
    const typ = parsed?.typ || candidate.type || "?";
    log("local ICE candidate", typ, candidate.protocol || "");
    if (typ === "relay") log("TURN relay candidate gathered");
}

function streamSize() {
    const video = document.getElementById("video");
    return {
        w: video.videoWidth || hostMeta?.streamW || 960,
        h: video.videoHeight || hostMeta?.streamH || 540,
    };
}

function layoutDimensions() {
    const { w: sw, h: sh } = streamSize();
    const viewport = document.getElementById("viewport");
    const pad = platform.mobile ? 8 : 32;
    const maxW = Math.max(120, viewport.clientWidth - pad);
    const maxH = Math.max(120, viewport.clientHeight - pad);

    if (displayMode === "fit") {
        const scale = Math.min(maxW / sw, maxH / sh, 1);
        return {
            width: Math.max(1, Math.round(sw * scale)),
            height: Math.max(1, Math.round(sh * scale)),
        };
    }
    const z = zoomLevel / 100;
    return {
        width: Math.max(1, Math.round(sw * z)),
        height: Math.max(1, Math.round(sh * z)),
    };
}

function applyViewerLayout() {
    const container = document.getElementById("desktop-container");
    const video = document.getElementById("video");
    const { width, height } = layoutDimensions();

    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
    video.style.width = `${width}px`;
    video.style.height = `${height}px`;

    document.getElementById("zoom-label").textContent = `${zoomLevel}%`;
    document.getElementById("btn-fit").classList.toggle("active", displayMode === "fit");
    document.getElementById("btn-actual").classList.toggle("active", displayMode === "actual");
    updateToolbarInfo(stats.lastCoords);
}

function setDisplayMode(mode) {
    displayMode = mode;
    if (mode === "fit") {
        zoomLevel = 100;
        document.getElementById("zoom-slider").value = "100";
    }
    applyViewerLayout();
}

function resetZoom() {
    zoomLevel = 100;
    document.getElementById("zoom-slider").value = "100";
    applyViewerLayout();
}

function setupViewerControls() {
    document.getElementById("zoom-slider").addEventListener("input", (e) => {
        zoomLevel = parseInt(e.target.value, 10);
        if (displayMode === "fit") setDisplayMode("actual");
        applyViewerLayout();
    });
    document.getElementById("btn-fit").addEventListener("click", () => setDisplayMode("fit"));
    document.getElementById("btn-actual").addEventListener("click", () => setDisplayMode("actual"));
    document.getElementById("btn-reset-zoom").addEventListener("click", resetZoom);
    document.getElementById("quality-select").addEventListener("change", (e) => {
        qualityMode = e.target.value;
        sendWhenDcOpen({ t: "quality", mode: qualityMode });
    });
    window.addEventListener("resize", () => applyViewerLayout());
}

function coordsFromClient(clientX, clientY) {
    const video = document.getElementById("video");
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

function videoCoords(event) {
    return coordsFromClient(event.clientX, event.clientY);
}

function touchCoords(touch) {
    return coordsFromClient(touch.clientX, touch.clientY);
}

function flushDcQueue() {
    if (!dc || dc.readyState !== "open") return;
    while (dcQueue.length) {
        dc.send(dcQueue.shift());
    }
}

function sendWhenDcOpen(event) {
    const payload = JSON.stringify(event);
    if (!dc) return;
    if (dc.readyState === "open") {
        dc.send(payload);
        return;
    }
    if (dc.readyState === "connecting") {
        dcQueue.push(payload);
    }
}

function sendInput(event) {
    if (!canSendInput()) {
        const payload = JSON.stringify(event);
        if (dc && (dc.readyState === "connecting" || dc.readyState === "open")) {
            dcQueue.push(payload);
        }
        return;
    }
    sendWhenDcOpen(event);
}

function setRemoteDrag(active) {
    dragState.active = active;
    document.body.classList.toggle("remote-drag", active);
}

function beginDrag(button, coords) {
    if (!canSendInput()) return;
    setRemoteDrag(true);
    dragState.button = button;
    lastMoveSent = 0;
    log("mouseDown", button, coords.x.toFixed(4), coords.y.toFixed(4));
    sendInput({ t: "down", button, x: coords.x, y: coords.y });
}

function endDrag(event) {
    if (!dragState.active) return;
    const coords = (event && (videoCoords(event) || touchCoords(event))) || stats.lastCoords;
    const button = dragState.button || "left";
    if (coords) {
        log("mouseUp", button, coords.x.toFixed(4), coords.y.toFixed(4));
        sendInput({ t: "up", button, x: coords.x, y: coords.y });
    }
    setRemoteDrag(false);
    dragState.button = null;
}

function sendMove(coords) {
    if (!coords) return;
    const interval = dragState.active ? DRAG_MOVE_INTERVAL_MS : MOVE_INTERVAL_MS;
    const now = Date.now();
    if (now - lastMoveSent < interval) return;
    lastMoveSent = now;
    if (dragState.active) log("drag move", coords.x.toFixed(3), coords.y.toFixed(3));
    sendInput({ t: "move", x: coords.x, y: coords.y });
}

function codeToPyAutoKey(code) {
    if (!code) return null;
    if (CODE_TO_KEY[code]) return CODE_TO_KEY[code];
    if (code.startsWith("Key") && code.length === 4) return code.slice(3).toLowerCase();
    if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
    return null;
}

function setupPointerHandlers() {
    const video = document.getElementById("video");
    const opts = { passive: false };

    video.addEventListener("dragstart", (e) => e.preventDefault());
    video.addEventListener("selectstart", (e) => e.preventDefault());

    video.addEventListener(
        "mousedown",
        (event) => {
            event.preventDefault();
            if (!canSendInput()) return;
            controlActive = true;
            const coords = videoCoords(event);
            if (!coords) return;
            beginDrag(event.button === 2 ? "right" : event.button === 1 ? "middle" : "left", coords);
        },
        opts,
    );

    video.addEventListener("mousemove", (event) => {
        const coords = videoCoords(event);
        updateToolbarInfo(coords);
        sendMove(coords);
    });

    video.addEventListener("mouseup", (e) => {
        e.preventDefault();
        endDrag(e);
    });

    video.addEventListener("contextmenu", (e) => e.preventDefault());

    window.addEventListener("mouseup", () => {
        if (dragState.active) endDrag(null);
    });

    /* Touch → same down/move/up protocol */
    video.addEventListener(
        "touchstart",
        (e) => {
            e.preventDefault();
            if (!canSendInput()) return;
            controlActive = true;
            const t = e.changedTouches[0];
            if (!t) return;
            const coords = touchCoords(t);
            if (!coords) return;
            log("touchstart", coords.x.toFixed(3), coords.y.toFixed(3));
            beginDrag("left", coords);
        },
        opts,
    );

    video.addEventListener(
        "touchmove",
        (e) => {
            e.preventDefault();
            const t = e.changedTouches[0];
            if (!t) return;
            const coords = touchCoords(t);
            updateToolbarInfo(coords);
            sendMove(coords);
        },
        opts,
    );

    video.addEventListener(
        "touchend",
        (e) => {
            e.preventDefault();
            const t = e.changedTouches[0];
            log("touchend");
            endDrag(t ? { clientX: t.clientX, clientY: t.clientY } : null);
        },
        opts,
    );

    video.addEventListener(
        "touchcancel",
        (e) => {
            e.preventDefault();
            endDrag(null);
        },
        opts,
    );

    window.addEventListener("blur", () => {
        if (dragState.active) endDrag(null);
    });

    const onKey = (event) => {
        if (!controlActive || !canSendInput()) return;
        const key = codeToPyAutoKey(event.code);
        if (!key) return;
        event.preventDefault();
        sendInput(event.type === "keydown" ? { t: "keydown", key, code: event.code } : { t: "keyup", key, code: event.code });
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
}

async function playVideoElement() {
    const video = document.getElementById("video");
    if (!video.srcObject) return;

    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "true");
    video.setAttribute("x-webkit-airplay", "deny");

    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            await video.play();
            log("video.play ok attempt", attempt);
            return;
        } catch (err) {
            log("video.play attempt", attempt, err.message || err);
            await new Promise((r) => setTimeout(r, 200 * attempt));
        }
    }
}

function configureLowLatencyReceiver(receiver) {
    if (!receiver) return;
    try {
        if ("playoutDelayHint" in receiver) receiver.playoutDelayHint = 0;
        if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 0;
    } catch (_) { /* Safari may throw on unsupported hints */ }
}

function isSafariBaselineH264(codec) {
    if (codec.mimeType !== "video/H264") return false;
    const fmtp = (codec.sdpFmtpLine || "").toLowerCase();
    if (!fmtp) return true;
    return (
        fmtp.includes("42e01f") ||
        fmtp.includes("42001f") ||
        fmtp.includes("profile-level-id=42e01f")
    );
}

function preferReceiverH264(pc) {
    if (!platform.safari && !platform.ios) return;
    try {
        const caps = RTCRtpReceiver.getCapabilities("video");
        const h264 = caps.codecs.filter(isSafariBaselineH264);
        const h264Any = caps.codecs.filter((c) => c.mimeType === "video/H264");
        const preferred = (h264.length ? h264 : h264Any).concat(
            caps.codecs.filter((c) => c.mimeType !== "video/H264"),
        );
        const tr = pc.getTransceivers().find(
            (t) => t.receiver && t.direction === "recvonly",
        );
        if (tr && preferred.length) {
            tr.setCodecPreferences(preferred);
            log("receiver codec preference: H264 first", h264.length || h264Any.length);
        }
    } catch (err) {
        log("preferReceiverH264 skipped", err.message || err);
    }
}

function attachVideoTrack(evt) {
    const video = document.getElementById("video");
    const track = evt.track;
    track.enabled = true;

    let stream = evt.streams && evt.streams[0];
    if (!stream || !stream.getVideoTracks().length) {
        stream = new MediaStream();
        stream.addTrack(track);
    }
    if (video.srcObject !== stream) {
        video.srcObject = stream;
    }

    configureLowLatencyReceiver(evt.receiver);
    track.onmute = () => log("video track muted");
    track.onunmute = () => {
        log("video track unmuted");
        playVideoElement();
    };

    const onMeta = () => {
        log("video metadata", video.videoWidth, video.videoHeight);
        applyViewerLayout();
        playVideoElement();
    };
    video.addEventListener("loadedmetadata", onMeta, { once: true });
    video.addEventListener("resize", () => applyViewerLayout());
    playVideoElement();
}

function waitForIceGathering(peer, timeoutMs) {
    const ms = platform.ios ? 20000 : platform.safari ? 15000 : timeoutMs || 12000;
    return new Promise((resolve) => {
        if (peer.iceGatheringState === "complete") {
            resolve();
            return;
        }
        const done = () => {
            clearTimeout(timer);
            peer.removeEventListener("icegatheringstatechange", onChange);
            resolve();
        };
        const onChange = () => {
            stats.iceState = peer.iceGatheringState;
            log("iceGathering", peer.iceGatheringState);
            if (peer.iceGatheringState === "complete") done();
        };
        const timer = setTimeout(() => {
            log("ICE gather timeout — continuing", ms);
            done();
        }, ms);
        peer.addEventListener("icegatheringstatechange", onChange);
    });
}

function parseCandidate(line) {
    if (!line.startsWith("a=candidate:")) return null;
    const parts = line.slice("a=candidate:".length).split(" ");
    const typIndex = parts.indexOf("typ");
    if (typIndex < 0) return null;
    return { ip: parts[4], typ: parts[typIndex + 1] };
}

function keepCandidateLine(line) {
    const parsed = parseCandidate(line);
    if (!parsed) return true;
    if (parsed.typ === "host") return false;
    if (USABLE_CANDIDATE_TYPES.has(parsed.typ)) return true;
    const ip = parsed.ip;
    if (ip.endsWith(".local")) return true;
    if (["127.0.0.1", "0.0.0.0", "::1"].includes(ip)) return true;
    if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
    return false;
}

function filterSdpCandidates(sdp) {
    const lines = sdp.replace(/\r\n/g, "\n").split("\n").filter((line) => {
        if (!line.startsWith("a=candidate:")) return true;
        return keepCandidateLine(line);
    });
    let body = lines.join("\r\n");
    if (body && !body.endsWith("\r\n")) body += "\r\n";
    return body;
}

function setupDataChannel(channel) {
    dc = channel;
    stats.dcState = channel.readyState;
    log("DataChannel setup", channel.readyState);

    channel.addEventListener("open", () => {
        stats.dcState = "open";
        log("DataChannel onopen", "pc=", pc && pc.connectionState, "ice=", pc && pc.iceConnectionState);
        refreshInputReady();
        if (canSendInput()) {
            setStatus("Live", true);
        }
    });

    channel.addEventListener("close", () => {
        stats.dcState = "closed";
        const video = document.getElementById("video");
        const hasVideo = video && video.videoWidth > 0;
        log("DataChannel onclose", "pc=", pc && pc.connectionState, "video=", hasVideo);
        if (
            sessionActive &&
            pc &&
            pc.connectionState !== "connected" &&
            !hasVideo
        ) {
            setStatus("DC closed", false);
        }
    });

    channel.addEventListener("error", (e) => {
        stats.dcState = "error";
        console.error("[any-remote] DataChannel error", e);
    });

    channel.addEventListener("message", (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            if (msg.t === "meta") {
                hostMeta = msg;
                if (msg.quality) {
                    qualityMode = msg.quality;
                    document.getElementById("quality-select").value = qualityMode;
                }
                if (msg.codec) stats.codec = msg.codec;
                log("meta", msg.quality, msg.codec, msg.streamW, "x", msg.streamH);
                applyViewerLayout();
                playVideoElement();
            }
        } catch (_) { /* ignore */ }
    });
}

function effectiveQuality() {
    if (platform.ios || (platform.mobile && qualityMode === "balanced")) return "mobile";
    return qualityMode;
}

function cleanupPeer() {
    stopStatsPoll();
    inputReady = false;
    stats.relay = false;
    stats.localCandType = "—";
    stats.remoteCandType = "—";
    stats.connState = "closed";
    stats.iceConnState = "closed";

    if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (dc) {
        dc.close();
        dc = null;
    }
    dcQueue.length = 0;
    if (pc) {
        pc.close();
        pc = null;
    }
    const video = document.getElementById("video");
    if (video) video.srcObject = null;
    updateToolbarInfo(null);
}

function scheduleReconnect() {
    if (!sessionActive || reconnectAttempts >= MAX_RECONNECT) return;
    reconnectAttempts += 1;
    const delay = 1500 * reconnectAttempts;
    log("reconnect attempt", reconnectAttempts, "in", delay);
    setStatus(`Reconnect ${reconnectAttempts}…`, false);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (sessionActive) connectSession();
    }, delay);
}

function wirePeerEvents() {
    pc.addEventListener("icecandidate", (ev) => {
        if (ev.candidate) logLocalIceCandidate(ev.candidate);
    });

    pc.addEventListener("iceconnectionstatechange", () => {
        stats.iceConnState = pc.iceConnectionState;
        stats.iceState = pc.iceGatheringState;
        log("iceConnectionState", pc.iceConnectionState);
        refreshInputReady();
        if (isIceConnected()) playVideoElement();
        if (pc.iceConnectionState === "failed" && sessionActive) {
            setStatus("ICE failed", false);
            scheduleReconnect();
        }
    });

    pc.addEventListener("connectionstatechange", () => {
        stats.connState = pc.connectionState;
        log("connectionState", pc.connectionState, "ice=", pc.iceConnectionState);
        refreshInputReady();
        if (disconnectTimer) {
            clearTimeout(disconnectTimer);
            disconnectTimer = null;
        }
        if (pc.connectionState === "connected") {
            reconnectAttempts = 0;
            if (canSendInput()) {
                setStatus("Live", true);
            } else {
                setStatus("Connected (no input yet)", true);
            }
            playVideoElement();
            refreshConnectionStats();
        } else if (pc.connectionState === "failed") {
            setStatus("Failed", false);
            if (sessionActive) scheduleReconnect();
        } else if (pc.connectionState === "disconnected") {
            setStatus("Reconnecting…", false);
            if (sessionActive) {
                const delay = platform.ios ? 5000 : 2500;
                disconnectTimer = setTimeout(() => {
                    disconnectTimer = null;
                    if (pc && pc.connectionState === "disconnected" && sessionActive) {
                        scheduleReconnect();
                    }
                }, delay);
            }
        }
    });

    pc.addEventListener("track", (evt) => {
        if (evt.track.kind !== "video") return;
        attachVideoTrack(evt);
    });
}

function connectSession() {
    cleanupPeer();
    inputReady = false;
    stats.dcState = "connecting";
    stats.iceState = "new";
    stats.connState = "connecting";
    stats.iceConnState = "new";

    return fetchIceServers()
        .then((iceServers) => {
            log("platform", platform, "quality", effectiveQuality());
            pc = new RTCPeerConnection(buildPeerConnectionConfig(iceServers));
            wirePeerEvents();
            startStatsPoll();

            pc.addTransceiver("video", { direction: "recvonly" });
            preferReceiverH264(pc);

            const dcOpts = platform.ios
                ? { ordered: false, maxRetransmits: 0 }
                : { ordered: true };
            setupDataChannel(pc.createDataChannel("input", dcOpts));

            const q = effectiveQuality();
            return pc
                .createOffer()
                .then((offer) => pc.setLocalDescription(offer))
                .then(() => waitForIceGathering(pc, ICE_GATHER_TIMEOUT_MS))
                .then(() => {
                    const sdp = filterSdpCandidates(pc.localDescription.sdp);
                    const counts = countSdpCandidates(sdp);
                    log("offer SDP ICE", counts);
                    return fetch("/offer", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            sdp,
                            type: pc.localDescription.type,
                            quality: q,
                            mobile: platform.mobile,
                            safari: platform.safari,
                            ios: platform.ios,
                        }),
                    });
                });
        })
        .then((r) => {
            if (!r.ok) throw new Error("Signaling " + r.status);
            return r.json();
        })
        .then((answer) => {
            answer.sdp = filterSdpCandidates(answer.sdp);
            log("answer SDP ICE", countSdpCandidates(answer.sdp));
            if (answer.quality) {
                qualityMode = answer.quality;
                document.getElementById("quality-select").value = qualityMode;
            }
            if (answer.peerId) log("assigned peerId", answer.peerId);
            if (answer.codec) {
                stats.codec = answer.codec;
                log("negotiated codec", answer.codec, "quality", answer.quality);
            }
            return pc.setRemoteDescription(answer).then(() => {
                playVideoElement();
                if (platform.ios) {
                    setTimeout(playVideoElement, 400);
                    setTimeout(playVideoElement, 1200);
                }
                refreshConnectionStats();
            });
        })
        .catch((err) => {
            console.error(err);
            setStatus("Error", false);
            if (sessionActive) scheduleReconnect();
        });
}

function countSdpCandidates(sdp) {
    const counts = { host: 0, srflx: 0, relay: 0, prflx: 0 };
    for (const line of sdp.replace(/\r\n/g, "\n").split("\n")) {
        const p = parseCandidate(line);
        if (p && counts[p.typ] !== undefined) counts[p.typ] += 1;
    }
    return counts;
}

function start() {
    sessionActive = true;
    reconnectAttempts = 0;
    controlActive = false;
    inputReady = false;
    hostMeta = null;
    qualityMode = document.getElementById("quality-select").value;

    document.getElementById("start").style.display = "none";
    document.getElementById("stop").style.display = "inline-block";
    setStatus("Connecting…", false);

    log("start", platform);
    connectSession();
}

function stop() {
    sessionActive = false;
    if (dragState.active) endDrag(null);
    cleanupPeer();

    document.getElementById("stop").style.display = "none";
    document.getElementById("start").style.display = "inline-block";
    setStatus("Offline", false);
    stats.dcState = "closed";
    stats.fps = 0;
    applyViewerLayout();
    updateToolbarInfo(null);
}

function startFpsMonitor() {
    const video = document.getElementById("video");
    let frames = 0;
    let lastT = performance.now();

    function tick(now) {
        frames += 1;
        if (now - lastT >= 1000) {
            stats.fps = frames;
            frames = 0;
            lastT = now;
            updateToolbarInfo(stats.lastCoords);
        }
        if (video.srcObject && video.requestVideoFrameCallback) {
            video.requestVideoFrameCallback(tick);
        }
    }
    if (video.requestVideoFrameCallback) {
        video.requestVideoFrameCallback(tick);
    }
}

document.getElementById("start").addEventListener("click", start);
document.getElementById("stop").addEventListener("click", stop);

document.addEventListener("visibilitychange", () => {
    if (!document.hidden && sessionActive) {
        log("visibility visible — replay video");
        playVideoElement();
    }
});

initMobileDefaults();
setupViewerControls();
setupPointerHandlers();
startFpsMonitor();
