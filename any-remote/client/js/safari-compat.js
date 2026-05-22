/** Safari / iOS WebRTC — H264 prefs + stable video attach (singleton stream). */

import {
    applyInlinePlaybackFlags,
    bindVideoLifecycleOnce,
    forcePlayVideo,
    getRemoteVideoSingleton,
    startAutoplayRetryLoop,
} from "./video-singleton.js";
import { attachTrackToStableStream, bindStableStreamToVideo } from "./media-stream.js";

export function isBaselineH264(codec) {
    if (codec.mimeType !== "video/H264") return false;
    const f = (codec.sdpFmtpLine || "").toLowerCase();
    if (!f) return true;
    return (
        f.includes("42e01f") ||
        f.includes("42001f") ||
        f.includes("packetization-mode=1")
    );
}

export function preferReceiverH264(pc, platform) {
    if (!platform.safari && !platform.ios) return;
    try {
        const caps = RTCRtpReceiver.getCapabilities("video");
        const h264 = caps.codecs.filter((c) => c.mimeType === "video/H264");
        const baseline = h264.filter(isBaselineH264);
        const preferred = (baseline.length ? baseline : h264).filter(
            (c) => c.mimeType === "video/H264",
        );
        const tr = pc.getTransceivers().find(
            (t) => t.receiver && t.direction === "recvonly",
        );
        if (tr && preferred.length) {
            tr.setCodecPreferences(preferred);
            console.log("[any-remote] H264-only codec preferences");
        }
    } catch (_) {}
}

export function configureLowLatencyReceiver(receiver) {
    if (!receiver) return;
    try {
        if ("playoutDelayHint" in receiver) receiver.playoutDelayHint = 0;
        if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 0;
    } catch (_) {}
}

export async function playVideoElement(video) {
    return forcePlayVideo();
}

/**
 * Attach remote track to singleton video + stable MediaStream (never new <video>).
 */
export function attachVideoTrack(evt, _videoIgnored, onLayout, videoMonitor = null) {
    const video = getRemoteVideoSingleton();
    const track = evt.track;
    track.enabled = true;

    attachTrackToStableStream(track);
    bindStableStreamToVideo(video);
    configureLowLatencyReceiver(evt.receiver);

    bindVideoLifecycleOnce({
        onMetadata: () => onLayout?.(),
        onStalled: () => videoMonitor?._renderRecover?.("stalled"),
        onPlaying: () => videoMonitor?._setHealth?.("ok"),
    });

    if (videoMonitor) {
        videoMonitor.bindTrack(evt);
    } else {
        forcePlayVideo();
        startAutoplayRetryLoop();
    }

    return { track, stream: video.srcObject };
}
