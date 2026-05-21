/**
 * Any-Remote browser controller — real-size zoom, quality modes, low-latency video.
 */

let pc = null;
let dc = null;
let lastMoveSent = 0;
let controlActive = false;
let hostMeta = null;

let zoomLevel = 100;
let displayMode = "fit";
let qualityMode = "balanced";

const MOVE_INTERVAL_MS = 33;
const DEBUG = true;

const ICE_CONFIG = {
    sdpSemantics: "unified-plan",
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

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
    lastFrameTs: 0,
    fps: 0,
    frameCount: 0,
    lastCoords: null,
};

function log(...args) {
    if (DEBUG) console.log("[any-remote]", ...args);
}

function setStatus(text, live) {
    document.getElementById("status-text").textContent = text;
    document.getElementById("status-dot").classList.toggle("live", !!live);
}

function updateToolbarInfo(coords) {
    const video = document.getElementById("video");
    const coordsEl = document.getElementById("info-coords");
    const streamEl = document.getElementById("info-stream");
    const statsEl = document.getElementById("info-stats");

    if (coords) {
        stats.lastCoords = coords;
        coordsEl.textContent = `xy ${(coords.x * 100).toFixed(1)}% ${(coords.y * 100).toFixed(1)}% · ${displayMode} · ${zoomLevel}%`;
    }

    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    const rect = video.getBoundingClientRect();
    streamEl.textContent =
        vw > 0
            ? `src ${vw}×${vh} · view ${Math.round(rect.width)}×${Math.round(rect.height)} · ${qualityMode}`
            : `stream · ${qualityMode}`;

    statsEl.textContent = `dc ${stats.dcState} · ~${stats.fps} fps · q ${qualityMode}`;
}

/**
 * Intrinsic stream size (pixels).
 */
function streamSize() {
    const video = document.getElementById("video");
    return {
        w: video.videoWidth || hostMeta?.streamW || 960,
        h: video.videoHeight || hostMeta?.streamH || 540,
    };
}

/**
 * Compute real pixel dimensions for container + video (no CSS transform).
 */
function layoutDimensions() {
    const { w: sw, h: sh } = streamSize();
    const viewport = document.getElementById("viewport");
    const pad = 32;
    const maxW = Math.max(200, viewport.clientWidth - pad);
    const maxH = Math.max(150, viewport.clientHeight - pad);

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

    log("layout", displayMode, width, height, "zoom", zoomLevel);
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
        if (displayMode === "fit") {
            displayMode = "actual";
            document.getElementById("btn-fit").classList.remove("active");
            document.getElementById("btn-actual").classList.add("active");
        }
        applyViewerLayout();
    });

    document.getElementById("btn-fit").addEventListener("click", () => setDisplayMode("fit"));
    document.getElementById("btn-actual").addEventListener("click", () => setDisplayMode("actual"));
    document.getElementById("btn-reset-zoom").addEventListener("click", resetZoom);

    document.getElementById("quality-select").addEventListener("change", (e) => {
        qualityMode = e.target.value;
        log("quality selected", qualityMode);
        if (dc && dc.readyState === "open") {
            dc.send(JSON.stringify({ t: "quality", mode: qualityMode }));
            setStatus("Quality updated (reconnect for full effect)", true);
        }
    });

    window.addEventListener("resize", () => applyViewerLayout());
    applyViewerLayout();
}

function sendInput(event) {
    if (!dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify(event));
}

/**
 * Coords from getBoundingClientRect — video sized to exact aspect (object-fit: fill).
 */
function videoCoords(event) {
    const video = document.getElementById("video");
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;

    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

function codeToPyAutoKey(code) {
    if (!code) return null;
    if (CODE_TO_KEY[code]) return CODE_TO_KEY[code];
    if (code.startsWith("Key") && code.length === 4) return code.slice(3).toLowerCase();
    if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
    if (code.startsWith("Numpad") && code.length === 7) return code.slice(6);
    return null;
}

function setupInputHandlers() {
    const video = document.getElementById("video");

    video.addEventListener("click", () => {
        controlActive = true;
        video.focus();
        log("keyboard focus on video");
    });

    video.addEventListener("mousemove", (event) => {
        const coords = videoCoords(event);
        updateToolbarInfo(coords);
        if (!coords) return;
        const now = Date.now();
        if (now - lastMoveSent < MOVE_INTERVAL_MS) return;
        lastMoveSent = now;
        sendInput({ t: "move", x: coords.x, y: coords.y });
    });

    video.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const coords = videoCoords(event);
        if (!coords) return;
        sendInput({ t: "click", x: coords.x, y: coords.y, button: "left" });
    });

    video.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const coords = videoCoords(event);
        if (!coords) return;
        sendInput({ t: "click", x: coords.x, y: coords.y, button: "right" });
    });

    const onKey = (event) => {
        if (!controlActive || !dc || dc.readyState !== "open") return;
        const key = codeToPyAutoKey(event.code);
        if (!key) return;
        event.preventDefault();
        event.stopPropagation();
        sendInput(
            event.type === "keydown"
                ? { t: "keydown", key, code: event.code }
                : { t: "keyup", key, code: event.code },
        );
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
}

function configureLowLatencyReceiver(receiver) {
    if (!receiver) return;
    if ("playoutDelayHint" in receiver) receiver.playoutDelayHint = 0;
    if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 0;
    log("receiver low-latency hints set");
}

function startFpsMonitor() {
    const video = document.getElementById("video");
    let frames = 0;
    let lastT = performance.now();

    function tick(now, metadata) {
        frames += 1;
        if (now - lastT >= 1000) {
            stats.fps = frames;
            frames = 0;
            lastT = now;
            updateToolbarInfo(stats.lastCoords);
            if (DEBUG) log("render fps ~", stats.fps);
        }
        if (video.srcObject) {
            if (video.requestVideoFrameCallback) {
                video.requestVideoFrameCallback(tick);
            } else {
                requestAnimationFrame((t) => tick(t, null));
            }
        }
    }

    if (video.requestVideoFrameCallback) {
        video.requestVideoFrameCallback(tick);
    } else {
        setInterval(() => updateToolbarInfo(stats.lastCoords), 1000);
    }
}

function parseCandidate(line) {
    if (!line.startsWith("a=candidate:")) return null;
    const parts = line.slice("a=candidate:".length).split(" ");
    const typIndex = parts.indexOf("typ");
    if (typIndex < 0) return null;
    return { ip: parts[4], typ: parts[typIndex + 1] };
}

function isUnusableAddress(ip) {
    if (ip.endsWith(".local")) return true;
    if (["127.0.0.1", "0.0.0.0", "::1", "::"].includes(ip)) return true;
    if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
    return ip.startsWith("127.") || ip.startsWith("169.254.");
}

function keepCandidateLine(line) {
    const parsed = parseCandidate(line);
    if (!parsed) return true;
    if (parsed.typ === "host") return false;
    if (USABLE_CANDIDATE_TYPES.has(parsed.typ)) return true;
    return !isUnusableAddress(parsed.ip);
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

    channel.addEventListener("open", () => {
        stats.dcState = "open";
        log("DataChannel onopen");
        setStatus("Connected", true);
        dc.send(JSON.stringify({ t: "quality", mode: qualityMode }));
    });

    channel.addEventListener("close", () => {
        stats.dcState = "closed";
        log("DataChannel onclose");
        setStatus("Disconnected", false);
    });

    channel.addEventListener("error", (e) => {
        stats.dcState = "error";
        console.error("[any-remote] DataChannel onerror", e);
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
                log("meta", msg);
                applyViewerLayout();
            }
        } catch (_) { /* ignore */ }
    });
}

function negotiate() {
    pc.addTransceiver("video", { direction: "recvonly" });
    setupDataChannel(pc.createDataChannel("input"));

    return pc
        .createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(
            () =>
                new Promise((resolve) => {
                    if (pc.iceGatheringState === "complete") {
                        resolve();
                        return;
                    }
                    const check = () => {
                        if (pc.iceGatheringState === "complete") {
                            pc.removeEventListener("icegatheringstatechange", check);
                            resolve();
                        }
                    };
                    pc.addEventListener("icegatheringstatechange", check);
                }),
        )
        .then(() =>
            fetch("/offer", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sdp: filterSdpCandidates(pc.localDescription.sdp),
                    type: pc.localDescription.type,
                    quality: qualityMode,
                }),
            }),
        )
        .then((r) => {
            if (!r.ok) throw new Error("Signaling " + r.status);
            return r.json();
        })
        .then((answer) => {
            answer.sdp = filterSdpCandidates(answer.sdp);
            if (answer.quality) {
                qualityMode = answer.quality;
                document.getElementById("quality-select").value = qualityMode;
            }
            return pc.setRemoteDescription(answer);
        })
        .catch((err) => {
            console.error(err);
            alert("Connection failed: " + err);
            setStatus("Error", false);
        });
}

function start() {
    controlActive = false;
    hostMeta = null;
    qualityMode = document.getElementById("quality-select").value;

    document.getElementById("start").style.display = "none";
    document.getElementById("stop").style.display = "inline-block";
    setStatus("Connecting…", false);
    stats.dcState = "connecting";

    pc = new RTCPeerConnection(ICE_CONFIG);

    pc.addEventListener("track", (evt) => {
        if (evt.track.kind !== "video") return;
        const video = document.getElementById("video");
        video.srcObject = evt.streams[0];
        configureLowLatencyReceiver(evt.receiver);

        const onMeta = () => {
            log("video metadata", video.videoWidth, video.videoHeight);
            applyViewerLayout();
            startFpsMonitor();
        };
        video.addEventListener("loadedmetadata", onMeta, { once: true });
        video.addEventListener("resize", () => applyViewerLayout());
    });

    pc.addEventListener("connectionstatechange", () => {
        log("connectionState", pc.connectionState);
        if (pc.connectionState === "connected") {
            setStatus("Live", true);
        } else if (pc.connectionState === "failed") {
            setStatus("Failed", false);
        }
    });

    negotiate();
}

function stop() {
    controlActive = false;
    document.getElementById("stop").style.display = "none";
    document.getElementById("start").style.display = "inline-block";
    setStatus("Offline", false);
    stats.dcState = "closed";
    stats.fps = 0;

    if (dc) {
        dc.close();
        dc = null;
    }
    setTimeout(() => {
        if (pc) {
            pc.close();
            pc = null;
        }
        const video = document.getElementById("video");
        video.srcObject = null;
        applyViewerLayout();
        updateToolbarInfo(null);
    }, 200);
}

document.getElementById("start").addEventListener("click", start);
document.getElementById("stop").addEventListener("click", stop);

setupViewerControls();
setupInputHandlers();
