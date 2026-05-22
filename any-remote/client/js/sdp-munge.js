/**
 * Safari mobile SDP — H264 packetization-mode=1, drop VP8/VP9.
 */

export function mungeSdpForSafariMobile(sdp, platform) {
    if (!platform?.isSafariMobile && !(platform?.mobile && platform?.safari)) {
        return sdp;
    }

    const lines = sdp.replace(/\r\n/g, "\n").split("\n");
    const rtpmap = new Map();
    const fmtp = new Map();

    for (const line of lines) {
        if (line.startsWith("a=rtpmap:")) {
            const body = line.slice(9);
            const [pt, rest] = body.split(" ", 2);
            const codec = rest.split("/")[0].toUpperCase();
            rtpmap.set(pt, codec);
        }
        if (line.startsWith("a=fmtp:")) {
            const body = line.slice(7);
            const pt = body.split(" ")[0];
            fmtp.set(pt, line);
        }
    }

    const dropCodecs = new Set(["VP8", "VP9", "AV1", "VP8/90000", "VP9/90000"]);
    const dropPts = new Set();
    for (const [pt, codec] of rtpmap) {
        if (dropCodecs.has(codec) || codec.startsWith("VP8") || codec.startsWith("VP9")) {
            dropPts.add(pt);
        }
    }

    const out = [];
    for (let line of lines) {
        if (line.startsWith("a=rtpmap:")) {
            const pt = line.slice(9).split(" ")[0];
            if (dropPts.has(pt)) continue;
        }
        if (line.startsWith("a=fmtp:")) {
            const pt = line.slice(7).split(" ")[0];
            if (dropPts.has(pt)) continue;
            if (rtpmap.get(pt) === "H264" && !line.includes("packetization-mode")) {
                line = `${line};packetization-mode=1`;
            }
        }
        if (line.startsWith("a=rtcp-fb:")) {
            const pt = line.slice(10).split(" ")[0];
            if (dropPts.has(pt)) continue;
        }
        if (line.startsWith("m=video ")) {
            const parts = line.split(" ");
            if (parts.length >= 4) {
                const pts = parts.slice(3).filter((p) => !dropPts.has(p));
                const h264 = [];
                const other = [];
                for (const p of pts) {
                    if (rtpmap.get(p) === "H264") h264.push(p);
                    else other.push(p);
                }
                parts.splice(3, parts.length - 3, ...h264, ...other);
                line = parts.join(" ");
            }
        }
        out.push(line);
    }

    let body = out.join("\r\n");
    if (body && !body.endsWith("\r\n")) body += "\r\n";
    console.log("[any-remote] SDP munged for Safari mobile (H264 only)");
    return body;
}
