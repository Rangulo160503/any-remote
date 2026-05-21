/**
 * PC AFZ — browser controller.
 * STUN + filtered ICE candidates for cross-network WebRTC (ngrok = signaling only).
 */

let pc = null;
let dc = null;
let lastMoveSent = 0;

const MOVE_INTERVAL_MS = 50;

const ICE_CONFIG = {
    sdpSemantics: "unified-plan",
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const USABLE_CANDIDATE_TYPES = new Set(["srflx", "relay", "prflx"]);

function setStatus(text) {
    document.getElementById("status").textContent = text;
}

function sendInput(event) {
    if (!dc || dc.readyState !== "open") {
        return;
    }
    dc.send(JSON.stringify(event));
}

function videoCoords(event) {
    const video = document.getElementById("video");
    const rect = video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
        return null;
    }
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return {
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
    };
}

function setupInputHandlers() {
    const video = document.getElementById("video");

    video.addEventListener("mousemove", (event) => {
        const now = Date.now();
        if (now - lastMoveSent < MOVE_INTERVAL_MS) {
            return;
        }
        const coords = videoCoords(event);
        if (!coords) {
            return;
        }
        lastMoveSent = now;
        sendInput({ t: "move", x: coords.x, y: coords.y });
    });

    video.addEventListener("click", (event) => {
        const coords = videoCoords(event);
        if (!coords) {
            return;
        }
        const button = event.button === 2 ? "right" : "left";
        sendInput({ t: "click", x: coords.x, y: coords.y, button });
    });

    video.addEventListener("contextmenu", (event) => {
        event.preventDefault();
    });
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

/**
 * Drop host/local ICE candidates so only STUN srflx (and future TURN relay) are used.
 */
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
    console.debug(`SDP ICE filter: kept=${kept} dropped=${dropped}`);
    let body = lines.join("\r\n");
    if (body && !body.endsWith("\r\n")) {
        body += "\r\n";
    }
    return body;
}

function negotiate() {
    pc.addTransceiver("video", { direction: "recvonly" });

    dc = pc.createDataChannel("input");

    dc.addEventListener("open", () => {
        setStatus("Connected — controlling remote host");
    });

    dc.addEventListener("close", () => {
        setStatus("DataChannel closed");
    });

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
    pc = new RTCPeerConnection(ICE_CONFIG);

    pc.addEventListener("track", (evt) => {
        if (evt.track.kind === "video") {
            document.getElementById("video").srcObject = evt.streams[0];
        }
    });

    pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "connected") {
            setStatus("Video connected");
        } else {
            setStatus("WebRTC: " + pc.connectionState);
        }
    });

    pc.addEventListener("iceconnectionstatechange", () => {
        console.log("ICE connection state:", pc.iceConnectionState);
    });

    setupInputHandlers();

    document.getElementById("start").style.display = "none";
    document.getElementById("stop").style.display = "inline-block";
    setStatus("Connecting (STUN gathering)…");
    negotiate();
}

function stop() {
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
    }, 200);
}
