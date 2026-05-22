/**
 * Stable MediaStream instance — Safari breaks when replacing streams repeatedly.
 */

let stableStream = null;

export function getStableMediaStream() {
    if (!stableStream) {
        stableStream = new MediaStream();
        console.log("[any-remote] stable MediaStream created");
    }
    return stableStream;
}

/**
 * Attach incoming track to the single stable stream (replace prior video track).
 * @param {MediaStreamTrack} track
 */
export function attachTrackToStableStream(track) {
    const stream = getStableMediaStream();
    track.enabled = true;

    for (const t of stream.getVideoTracks()) {
        if (t.id !== track.id) {
            stream.removeTrack(t);
            try {
                t.stop();
            } catch (_) {}
        }
    }
    if (!stream.getVideoTracks().some((t) => t.id === track.id)) {
        stream.addTrack(track);
    }
    return stream;
}

export function bindStableStreamToVideo(video) {
    const stream = getStableMediaStream();
    if (video.srcObject !== stream) {
        video.srcObject = stream;
    }
    return stream;
}

/** Peer teardown: detach from element but keep stream object for reuse. */
export function detachStableFromVideo(video) {
    if (video) video.srcObject = null;
}

export function resetStableStreamTracks() {
    if (!stableStream) return;
    for (const t of stableStream.getVideoTracks()) {
        stableStream.removeTrack(t);
        try {
            t.stop();
        } catch (_) {}
    }
}
