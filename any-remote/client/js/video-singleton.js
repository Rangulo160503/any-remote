/**
 * Single global <video> for Safari — never recreate or replace the DOM node.
 */

let playRetryTimer = null;
let lifecycleBound = false;

export function applyInlinePlaybackFlags(video) {
    if (!video) return;
    video.autoplay = true;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.controls = false;
    video.disablePictureInPicture = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.setAttribute("autoplay", "");
    video.setAttribute("muted", "");
}

/**
 * Create once, append once, reuse forever.
 * @returns {HTMLVideoElement}
 */
export function getRemoteVideoSingleton() {
    if (window.__remoteVideoSingleton) {
        applyInlinePlaybackFlags(window.__remoteVideoSingleton);
        return window.__remoteVideoSingleton;
    }

    const mount =
        document.getElementById("video-mount") ||
        document.getElementById("desktop-container");
    if (!mount) {
        throw new Error("[any-remote] video mount not found");
    }

    const existing = mount.querySelector("video#video");
    if (existing) {
        window.__remoteVideoSingleton = existing;
        applyInlinePlaybackFlags(existing);
        return existing;
    }

    const video = document.createElement("video");
    video.id = "video";
    video.tabIndex = 0;
    applyInlinePlaybackFlags(video);

    const overlay = mount.querySelector("#touch-overlay");
    if (overlay) mount.insertBefore(video, overlay);
    else mount.prepend(video);

    window.__remoteVideoSingleton = video;
    console.log("[any-remote] video singleton created (once)");
    return video;
}

export function bindVideoLifecycleOnce(handlers = {}) {
    const video = getRemoteVideoSingleton();
    if (lifecycleBound) return video;
    lifecycleBound = true;

    video.addEventListener("loadedmetadata", () => {
        console.log(
            "[any-remote] video metadata",
            video.videoWidth,
            video.videoHeight,
        );
        handlers.onMetadata?.();
    });
    video.addEventListener("stalled", () => {
        console.warn("[any-remote] video stalled");
        handlers.onStalled?.();
    });
    video.addEventListener("waiting", () => console.warn("[any-remote] video waiting"));
    video.addEventListener("playing", () => {
        console.log("[any-remote] video playing");
        handlers.onPlaying?.();
    });
    video.addEventListener("pause", () => console.warn("[any-remote] video paused"));
    return video;
}

export function stopAutoplayRetryLoop() {
    if (playRetryTimer) clearInterval(playRetryTimer);
    playRetryTimer = null;
}

/** Retry play() every 1s until playing with data. */
export function startAutoplayRetryLoop() {
    stopAutoplayRetryLoop();
    const video = getRemoteVideoSingleton();

    const tick = async () => {
        if (!video.srcObject) return;
        applyInlinePlaybackFlags(video);
        const needsPlay =
            video.paused ||
            video.readyState < 2 ||
            (video.videoWidth === 0 && video.readyState >= 1);
        if (needsPlay) {
            try {
                await video.play();
            } catch (_) {
                /* Safari gesture / policy */
            }
        }
    };

    tick();
    playRetryTimer = setInterval(tick, 1000);
}

export async function forcePlayVideo() {
    const video = getRemoteVideoSingleton();
    if (!video.srcObject) return false;
    applyInlinePlaybackFlags(video);
    for (let i = 0; i < 4; i++) {
        try {
            await video.play();
            return !video.paused;
        } catch (_) {
            await new Promise((r) => setTimeout(r, 150 * (i + 1)));
        }
    }
    return !video.paused;
}

/** Detach media only — never remove the element. */
export function detachVideoSrcObject() {
    const video = getRemoteVideoSingleton();
    video.srcObject = null;
}
