/**
 * PC AFZ — browser controller.
 * Connects to PC CASA host, shows remote video, sends mouse events on DataChannel "input".
 */

let pc = null;
let dc = null;
let lastMoveSent = 0;

const MOVE_INTERVAL_MS = 50; // ~20 move events/sec max

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

function negotiate() {
    pc.addTransceiver("video", { direction: "recvonly" });

    dc = pc.createDataChannel("input");

    dc.addEventListener("open", () => {
        setStatus("Connected — controlling PC CASA");
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
            return fetch("/offer", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sdp: offer.sdp, type: offer.type }),
            });
        })
        .then((response) => {
            if (!response.ok) {
                throw new Error("Signaling failed: " + response.status);
            }
            return response.json();
        })
        .then((answer) => pc.setRemoteDescription(answer))
        .catch((err) => {
            console.error(err);
            alert("Connection failed: " + err);
            setStatus("Error");
        });
}

function start() {
    const config = { sdpSemantics: "unified-plan" };
    // No STUN/TURN — Tailscale provides reachable host candidates.
    pc = new RTCPeerConnection(config);

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

    setupInputHandlers();

    document.getElementById("start").style.display = "none";
    document.getElementById("stop").style.display = "inline-block";
    setStatus("Connecting…");
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
