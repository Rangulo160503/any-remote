/**
 * Any-Remote — modular entry (desktop + Citrix-like mobile UX).
 */

import { detectPlatform } from "./platform.js";
import { StatsHUD } from "./stats-hud.js";
import { Renderer } from "./renderer.js";
import { QualityController } from "./quality-controller.js";
import { ConnectionManager } from "./connection-manager.js";
import { MobileInputController } from "./mobile-input.js";
import { GestureController } from "./gestures.js";
import { KeyboardBridge } from "./keyboard-bridge.js";
import { recoverVideoIfFrozen } from "./safari-compat.js";

const platform = detectPlatform();
const hud = new StatsHUD();
const renderer = new Renderer(platform);
let conn;
const quality = new QualityController(platform, (e) => conn?.send(e));
conn = new ConnectionManager(platform, hud, renderer, quality);

let mobileInput = null;
let gestures = null;
let keyboard = null;
let lastFrameAt = Date.now();
let fpsFrames = 0;
let fpsLast = performance.now();

function setStatus(text, live) {
    document.getElementById("status-text").textContent = text;
    document.getElementById("status-dot").classList.toggle("live", !!live);
}

function initPlatformUi() {
    if (!platform.mobile) return;
    document.body.classList.add("is-mobile");
    if (platform.safari) document.body.classList.add("is-safari");
    const sel = document.getElementById("quality-select");
    if (sel) sel.value = "mobile";
    quality.mode = "mobile";
    document.getElementById("desktop-toolbar")?.classList.add("hide-mobile");
    document.getElementById("mobile-toolbar")?.classList.remove("hidden");
}

function bindDesktopPointer() {
    const video = document.getElementById("video");
    if (!video) return;
    const drag = { active: false, button: null };
    let lastMove = 0;

    video.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (!conn.canSendInput()) return;
        const c = renderer.coordsFromClient(e.clientX, e.clientY);
        if (!c) return;
        drag.active = true;
        drag.button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
        conn.send({ t: "down", button: drag.button, x: c.x, y: c.y });
    });
    video.addEventListener("mousemove", (e) => {
        const c = renderer.coordsFromClient(e.clientX, e.clientY);
        if (!c || !conn.canSendInput()) return;
        const now = Date.now();
        if (now - lastMove < (drag.active ? 16 : 33)) return;
        lastMove = now;
        conn.send({ t: "move", x: c.x, y: c.y });
        if (hud.els.coords) {
            hud.els.coords.textContent = `${(c.x * 100).toFixed(0)}% ${(c.y * 100).toFixed(0)}%`;
        }
    });
    video.addEventListener("mouseup", (e) => {
        if (!drag.active) return;
        const c = renderer.coordsFromClient(e.clientX, e.clientY);
        if (c) conn.send({ t: "up", button: drag.button, x: c.x, y: c.y });
        drag.active = false;
    });
    video.addEventListener("contextmenu", (e) => e.preventDefault());
}

function bindControls() {
    document.getElementById("start")?.addEventListener("click", () => {
        document.getElementById("start").style.display = "none";
        document.getElementById("stop").style.display = "inline-block";
        setStatus("Connecting…", false);
        conn.start();
    });
    document.getElementById("stop")?.addEventListener("click", stopSession);
    document.getElementById("m-stop")?.addEventListener("click", stopSession);
    document.getElementById("m-reconnect")?.addEventListener("click", () => {
        conn.reconnectAttempts = 0;
        conn.connect();
    });

    document.getElementById("quality-select")?.addEventListener("change", (e) => {
        quality.mode = e.target.value;
        conn.send({ t: "quality", mode: e.target.value });
    });
    document.getElementById("m-quality")?.addEventListener("change", (e) => {
        quality.mode = e.target.value;
        document.getElementById("quality-select").value = e.target.value;
        conn.send({ t: "quality", mode: e.target.value });
    });

    document.getElementById("zoom-slider")?.addEventListener("input", (e) => {
        renderer.zoomLevel = parseInt(e.target.value, 10);
        renderer.displayMode = "actual";
        renderer.apply();
    });
    document.getElementById("btn-fit")?.addEventListener("click", () => {
        renderer.displayMode = "fit";
        renderer.zoomLevel = 100;
        document.getElementById("zoom-slider").value = "100";
        renderer.apply();
    });
    document.getElementById("btn-actual")?.addEventListener("click", () => {
        renderer.displayMode = "actual";
        renderer.apply();
    });
    document.getElementById("btn-reset-zoom")?.addEventListener("click", () => {
        renderer.zoomLevel = 100;
        renderer.apply();
    });
    document.getElementById("m-fit")?.addEventListener("click", () => {
        renderer.displayMode = "fit";
        renderer.apply();
    });

    document.getElementById("btn-touch-mode")?.addEventListener("click", () => mobileInput?.toggleMode());
    document.getElementById("btn-touch-direct")?.addEventListener("click", () => mobileInput?.setMode("direct"));
    document.getElementById("m-keyboard")?.addEventListener("click", () => keyboard?.toggle());
    document.getElementById("m-toggle-bar")?.addEventListener("click", () => {
        document.getElementById("mobile-toolbar")?.classList.toggle("collapsed");
    });

    document.getElementById("sensitivity-slider")?.addEventListener("input", (e) => {
        if (mobileInput) mobileInput.sensitivity = parseFloat(e.target.value);
        localStorage.setItem("any-remote-sensitivity", e.target.value);
    });

    window.addEventListener("resize", () => renderer.apply());
    window.addEventListener("orientationchange", () => setTimeout(() => renderer.apply(), 300));
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden && conn.sessionActive) {
            recoverVideoIfFrozen(document.getElementById("video"), lastFrameAt);
        }
    });
}

function stopSession() {
    conn.stop();
    document.getElementById("stop").style.display = "none";
    document.getElementById("start").style.display = "inline-block";
    setStatus("Offline", false);
}

function startFpsLoop() {
    const video = document.getElementById("video");
    const tick = (now) => {
        fpsFrames++;
        if (now - fpsLast >= 1000) {
            const fps = fpsFrames;
            fpsFrames = 0;
            fpsLast = now;
            lastFrameAt = Date.now();
            hud.update({ fps });
            quality.tick(hud, fps);
            if (conn.sessionActive) recoverVideoIfFrozen(video, lastFrameAt);
        }
        if (video?.srcObject?.active) {
            if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
            else requestAnimationFrame(tick);
        }
    };
    if (video?.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
}

conn.onState = (s) => {
    if (s === "connected") setStatus("Live", true);
    else if (s === "reconnecting") setStatus("Reconnecting…", false);
    else if (s === "connecting") setStatus("Connecting…", false);
    else if (s === "failed") setStatus("Failed", false);
};

conn.onMeta = (msg) => {
    renderer.setMeta(msg);
    quality.onMeta(msg);
};

conn.onInputReady = () => setStatus("Live", true);

keyboard = new KeyboardBridge((e) => conn.send(e));

if (platform.mobile) {
    mobileInput = new MobileInputController(renderer, (e) => conn.send(e), platform);
    mobileInput.setMode(mobileInput.mode);
    gestures = new GestureController(mobileInput, keyboard, () => conn.canSendInput());
} else {
    bindDesktopPointer();
}

initPlatformUi();
bindControls();
startFpsLoop();
hud.render();

console.log("[any-remote] ready", platform, "relay_policy=", platform.isSafariMobile ? "relay" : "all");
