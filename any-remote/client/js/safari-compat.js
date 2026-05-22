/** Safari / iOS WebRTC and video playback compatibility. */

export function isBaselineH264(codec) {
    if (codec.mimeType !== "video/H264") return false;
    const f = (codec.sdpFmtpLine || "").toLowerCase();
    if (!f) return true;
    return f.includes("42e01f") || f.includes("42001f");
}

export function preferReceiverH264(pc, platform) {
    if (!platform.safari && !platform.ios) return;
    try {
        const caps = RTCRtpReceiver.getCapabilities("video");
        const h264 = caps.codecs.filter(isBaselineH264);
        const any = caps.codecs.filter((c) => c.mimeType === "video/H264");
        const pref = (h264.length ? h264 : any).concat(
            caps.codecs.filter((c) => c.mimeType !== "video/H264"),
        );
        const tr = pc.getTransceivers().find(
            (t) => t.receiver && t.direction === "recvonly",
        );
        if (tr && pref.length) tr.setCodecPreferences(pref);
    } catch (_) {
        /* unsupported */
    }
}

export function configureLowLatencyReceiver(receiver) {
    if (!receiver) return;
    try {
        if ("playoutDelayHint" in receiver) receiver.playoutDelayHint = 0;
        if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 0;
    } catch (_) {
        /* Safari */
    }
}

export async function playVideoElement(video) {
    if (!video?.srcObject) return;
    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "true");
    for (let i = 1; i <= 4; i++) {
        try {
            await video.play();
            return;
        } catch (_) {
            await new Promise((r) => setTimeout(r, 200 * i));
        }
    }
}

export function attachVideoTrack(evt, video, onLayout, videoMonitor = null) {
    const track = evt.track;
    track.enabled = true;
    let stream = evt.streams?.[0];
    if (!stream?.getVideoTracks().length) {
        stream = new MediaStream();
        stream.addTrack(track);
    }
    if (video.srcObject !== stream) video.srcObject = stream;
    configureLowLatencyReceiver(evt.receiver);

    if (videoMonitor) {
        videoMonitor.bindTrack(evt);
    } else {
        track.onunmute = () => playVideoElement(video);
    }

    video.addEventListener(
        "loadedmetadata",
        () => {
            console.log("[any-remote] video metadata", video.videoWidth, video.videoHeight);
            onLayout?.();
            playVideoElement(video);
        },
        { once: true },
    );
    video.addEventListener("stalled", () => {
        console.warn("[any-remote] video stalled");
        videoMonitor?._scheduleRecover?.("stalled");
    });
    video.addEventListener("waiting", () => console.warn("[any-remote] video waiting"));
    video.addEventListener("playing", () => console.log("[any-remote] video playing"));
    playVideoElement(video);
    return { track, stream };
}
