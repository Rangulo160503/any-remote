/**
 * Browser controller — video coords with letterbox correction, keyboard, right-click.
 */

let pc = null;
let dc = null;
let lastMoveSent = 0;
let controlActive = false;
let hostMeta = null;

const MOVE_INTERVAL_MS = 50;
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

function log(...args) {
    if (DEBUG) {
        console.log("[any-remote]", ...args);
    }
}

function setStatus(text) {
    document.getElementById("status").textContent = text;
}

function sendInput(event) {
    if (!dc || dc.readyState !== "open") {
        log("send skipped (dc not open):", event.t);
        return;
    }
    const payload = JSON.stringify(event);
    dc.send(payload);
    if (event.t === "move") {
        log("mouse move", event.x.toFixed(4), event.y.toFixed(4));
    } else if (event.t === "click") {
        log("mouse click", event.button, event.x.toFixed(4), event.y.toFixed(4));
    } else if (event.t === "keydown" || event.t === "keyup") {
        log(event.t, event.key, "code=" + (event.code || ""));
    }
}

/**
 * Map pointer position to 0–1 inside the actual video picture (object-fit: contain).
 * Uses getBoundingClientRect() only for element position; accounts for letterbox/pillarbox.
 */
function videoCoords(event) {
    const video = document.getElementById("video");
    const rect = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (!vw || !vh || rect.width <= 0 || rect.height <= 0) {
        return null;
    }

    const elementAspect = rect.width / rect.height;
    const videoAspect = vw / vh;

    let renderWidth;
    let renderHeight;
    let offsetX;
    let offsetY;

    if (elementAspect > videoAspect) {
        renderHeight = rect.height;
        renderWidth = rect.height * videoAspect;
        offsetX = rect.left + (rect.width - renderWidth) / 2;
        offsetY = rect.top;
    } else {
        renderWidth = rect.width;
        renderHeight = rect.width / videoAspect;
        offsetX = rect.left;
        offsetY = rect.top + (rect.height - renderHeight) / 2;
    }

    const x = (event.clientX - offsetX) / renderWidth;
    const y = (event.clientY - offsetY) / renderHeight;

    if (x < 0 || x > 1 || y < 0 || y > 1) {
        return null;
    }

    return {
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
        renderWidth,
        renderHeight,
        offsetX,
        offsetY,
    };
}

function updateDebugOverlay(coords, event) {
    const dot = document.getElementById("cursor-dot");
    const debug = document.getElementById("coord-debug");

    if (!coords) {
        dot.style.display = "none";
        return;
    }

    const viewer = document.getElementById("viewer");
    const vr = viewer.getBoundingClientRect();
    dot.style.display = "block";
    dot.style.left = event.clientX - vr.left + "px";
    dot.style.top = event.clientY - vr.top + "px";

    const video = document.getElementById("video");
    const lines = [
        `norm: ${coords.x.toFixed(4)}, ${coords.y.toFixed(4)}`,
        `client: ${event.clientX}, ${event.clientY}`,
        `video: ${video.videoWidth}x${video.videoHeight}`,
        `render: ${Math.round(coords.renderWidth)}x${Math.round(coords.renderHeight)}`,
    ];
    if (hostMeta) {
        lines.push(
            `host screen: ${hostMeta.screenW}x${hostMeta.screenH}`,
            `host monitor: ${hostMeta.monitorW}x${hostMeta.monitorH}`,
        );
    }
    debug.textContent = lines.join("\n");
}

function codeToPyAutoKey(code) {
    if (!code) {
        return null;
    }
    if (CODE_TO_KEY[code]) {
        return CODE_TO_KEY[code];
    }
    if (code.startsWith("Key") && code.length === 4) {
        return code.slice(3).toLowerCase();
    }
    if (code.startsWith("Digit") && code.length === 6) {
        return code.slice(5);
    }
    if (code.startsWith("Numpad") && code.length === 7) {
        return code.slice(6);
    }
    return null;
}

function setupInputHandlers() {
    const video = document.getElementById("video");

    video.addEventListener("click", () => {
        controlActive = true;
        video.focus();
        log("control active — keyboard captured");
    });

    video.addEventListener("mousemove", (event) => {
        const coords = videoCoords(event);
        updateDebugOverlay(coords, event);
        if (!coords) {
            return;
        }
        const now = Date.now();
        if (now - lastMoveSent < MOVE_INTERVAL_MS) {
            return;
        }
        lastMoveSent = now;
        sendInput({ t: "move", x: coords.x, y: coords.y });
    });

    video.addEventListener("mousedown", (event) => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        const coords = videoCoords(event);
        if (!coords) {
            return;
        }
        sendInput({ t: "click", x: coords.x, y: coords.y, button: "left" });
    });

    video.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const coords = videoCoords(event);
        if (!coords) {
            return;
        }
        log("contextmenu -> right click");
        sendInput({ t: "click", x: coords.x, y: coords.y, button: "right" });
    });

    video.addEventListener("auxclick", (event) => {
        if (event.button !== 1) {
            return;
        }
        event.preventDefault();
        const coords = videoCoords(event);
        if (coords) {
            sendInput({ t: "click", x: coords.x, y: coords.y, button: "middle" });
        }
    });

    const onKey = (event) => {
        if (!controlActive || !dc || dc.readyState !== "open") {
            return;
        }
        const key = codeToPyAutoKey(event.code);
        if (!key) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();

        if (event.type === "keydown") {
            sendInput({ t: "keydown", key, code: event.code });
        } else {
            sendInput({ t: "keyup", key, code: event.code });
        }
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
}

function parseCandidate(line) {
    if (!line.startsWith("a=candidate:")) {
        return null;
    }
    const parts = line.slice("a=candidate:".length).split(" ");
    if (parts.length < 8) {
        return null;
    }
    const typIndex = parts.indexOf("typ");
    if (typIndex < 0) {
        return null;
    }
    return { ip: parts[4], typ: parts[typIndex + 1] };
}

function isUnusableAddress(ip) {
    if (ip.endsWith(".local")) {
        return true;
    }
    if (ip === "127.0.0.1" || ip === "0.0.0.0" || ip === "::1" || ip === "::") {
        return true;
    }
    if (ip.startsWith("10.") || ip.startsWith("192.168.")) {
        return true;
    }
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
        return true;
    }
    if (ip.startsWith("127.") || ip.startsWith("169.254.")) {
        return true;
    }
    return false;
}

function keepCandidateLine(line) {
    const parsed = parseCandidate(line);
    if (!parsed) {
        return true;
    }
    if (parsed.typ === "host") {
        return false;
    }
    if (USABLE_CANDIDATE_TYPES.has(parsed.typ)) {
        return true;
    }
    return !isUnusableAddress(parsed.ip);
}

function filterSdpCandidates(sdp) {
    let kept = 0;
    let dropped = 0;
    const lines = sdp.replace(/\r\n/g, "\n").split("\n").filter((line) => {
        if (!line.startsWith("a=candidate:")) {
            return true;
        }
        if (keepCandidateLine(line)) {
            kept += 1;
            return true;
        }
        dropped += 1;
        return false;
    });
    log(`SDP ICE filter: kept=${kept} dropped=${dropped}`);
    let body = lines.join("\r\n");
    if (body && !body.endsWith("\r\n")) {
        body += "\r\n";
    }
    return body;
}

function setupDataChannel(channel) {
    dc = channel;

    channel.addEventListener("open", () => {
        log("DataChannel onopen");
        setStatus("Connected — click video for keyboard");
    });

    channel.addEventListener("close", () => {
        log("DataChannel onclose");
        setStatus("DataChannel closed");
    });

    channel.addEventListener("error", (err) => {
        console.error("[any-remote] DataChannel onerror", err);
        setStatus("DataChannel error");
    });

    channel.addEventListener("message", (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            if (msg.t === "meta") {
                hostMeta = msg;
                log("host meta", msg);
            }
        } catch (_) {
            /* host does not send other messages */
        }
    });
}

function negotiate() {
    pc.addTransceiver("video", { direction: "recvonly" });

    setupDataChannel(pc.createDataChannel("input"));

    return pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
            return new Promise((resolve) => {
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
            });
        })
        .then(() => {
            const offer = pc.localDescription;
            const sdp = filterSdpCandidates(offer.sdp);
            return fetch("/offer", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sdp, type: offer.type }),
            });
        })
        .then((response) => {
            if (!response.ok) {
                throw new Error("Signaling failed: " + response.status);
            }
            return response.json();
        })
        .then((answer) => {
            answer.sdp = filterSdpCandidates(answer.sdp);
            return pc.setRemoteDescription(answer);
        })
        .catch((err) => {
            console.error(err);
            alert("Connection failed: " + err);
            setStatus("Error");
        });
}

function start() {
    controlActive = false;
    hostMeta = null;

    pc = new RTCPeerConnection(ICE_CONFIG);

    pc.addEventListener("track", (evt) => {
        if (evt.track.kind === "video") {
            const video = document.getElementById("video");
            video.srcObject = evt.streams[0];
            video.addEventListener(
                "loadedmetadata",
                () => log("video metadata", video.videoWidth, video.videoHeight),
                { once: true },
            );
        }
    });

    pc.addEventListener("connectionstatechange", () => {
        log("connectionState", pc.connectionState);
        if (pc.connectionState === "connected") {
            setStatus("Video connected — click video to type");
        } else {
            setStatus("WebRTC: " + pc.connectionState);
        }
    });

    pc.addEventListener("iceconnectionstatechange", () => {
        log("iceConnectionState", pc.iceConnectionState);
    });

    setupInputHandlers();

    document.getElementById("start").style.display = "none";
    document.getElementById("stop").style.display = "inline-block";
    setStatus("Connecting…");
    negotiate();
}

function stop() {
    controlActive = false;
    document.getElementById("stop").style.display = "none";
    document.getElementById("start").style.display = "inline-block";
    setStatus("Disconnected");

    if (dc) {
        dc.close();
        dc = null;
    }
    setTimeout(() => {
        if (pc) {
            pc.close();
            pc = null;
        }
        document.getElementById("video").srcObject = null;
        document.getElementById("cursor-dot").style.display = "none";
        document.getElementById("coord-debug").textContent = "—";
    }, 200);
}
