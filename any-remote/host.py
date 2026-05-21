"""
PC CASA — controlled host.

Each /offer creates an isolated RTCPeerConnection. Screen capture is shared
via MediaRelay so multiple viewers do not fight over one VideoStreamTrack.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import ssl
import time
from pathlib import Path
from typing import Optional

import pyautogui
from aiohttp import web
from aiortc import RTCPeerConnection, RTCRtpSender, RTCSessionDescription
from aiortc.contrib.media import MediaRelay

from ice_config import (
    ICE_CONFIGURATION,
    count_sdp_candidates,
    filter_sdp_candidates,
    ice_servers_json,
)
from input_handler import bind_capture, handle_message
from peer_session import PeerSession
from screen_track import ScreenCapture, ScreenStreamTrack
from stream_config import DEFAULT_QUALITY, QualityPreset, get_preset, max_preset

ROOT = Path(__file__).resolve().parent
CLIENT_DIR = ROOT / "client"
INDEX_HTML = CLIENT_DIR / "index.html"
CLIENT_JS = CLIENT_DIR / "client.js"

# Active peer connections (one RTCPeerConnection per viewer).
pcs: set[RTCPeerConnection] = set()
sessions: dict[str, PeerSession] = {}

capture: Optional[ScreenCapture] = None
shared_source: Optional[ScreenStreamTrack] = None
media_relay: Optional[MediaRelay] = None


def log_active_peers(reason: str = "") -> None:
    labels = [s.label for s in sessions.values()]
    logging.info(
        "active peers: %d %s%s",
        len(pcs),
        labels,
        f" ({reason})" if reason else "",
    )


def prefer_sender_codecs(pc: RTCPeerConnection, sender: RTCRtpSender, h264_first: bool) -> str:
    """Set codec preference order; Safari/iOS needs H.264."""
    kind = "video"
    codecs = RTCRtpSender.getCapabilities(kind).codecs
    h264 = [c for c in codecs if c.mimeType == "video/H264"]
    vp8 = [c for c in codecs if c.mimeType == "video/VP8"]
    preferred = (h264 + vp8) if h264_first else (vp8 + h264)
    if not preferred:
        preferred = codecs
    transceiver = next(t for t in pc.getTransceivers() if t.sender == sender)
    transceiver.setCodecPreferences(preferred)
    chosen = "video/H264" if h264_first and h264 else "video/VP8"
    return chosen


def sdp_video_codec(sdp: str) -> str:
    for line in sdp.splitlines():
        if "H264" in line or "h264" in line:
            if line.startswith("a=rtpmap:") and "H264" in line.upper():
                return "H264"
        if line.startswith("a=rtpmap:") and "VP8" in line:
            return "VP8"
    return "unknown"


def maybe_upgrade_shared_capture(preset: QualityPreset) -> None:
    """Raise shared capture resolution when a viewer requests higher quality."""
    global capture
    if capture is None:
        return
    current = capture._preset
    better = max_preset(current, preset)
    if better.name != current.name:
        capture.apply_preset(better)
        logging.info("shared capture upgraded -> %s", better.name)


def set_sender_bitrate(sender: RTCRtpSender, bitrate: int) -> bool:
    enc = getattr(sender, "_RTCRtpSender__encoder", None)
    if enc is not None and hasattr(enc, "target_bitrate"):
        enc.target_bitrate = bitrate
        return True
    return False


def tune_h264_sender(sender: RTCRtpSender, preset: QualityPreset) -> bool:
    """Safari-friendly H.264: Baseline, annex-B, in-band SPS/PPS, short GOP."""
    enc = getattr(sender, "_RTCRtpSender__encoder", None)
    if enc is None:
        return False
    codec = getattr(enc, "codec", None)
    if codec is None:
        return False
    opts = dict(codec.options or {})
    opts.update(
        {
            "tune": "zerolatency",
            "repeat-headers": "1",
            "annexb": "1",
            "keyint": str(max(30, preset.fps * 2)),
        }
    )
    codec.options = opts
    codec.profile = "baseline"
    return True


def request_sender_keyframe(sender: RTCRtpSender) -> None:
    try:
        sender._send_keyframe()
    except Exception as exc:
        logging.debug("keyframe request failed: %s", exc)


def prefer_h264_in_answer_sdp(sdp: str) -> str:
    """Reorder m=video payload types so H264 is listed before VP8 (Safari)."""
    lines = sdp.replace("\r\n", "\n").split("\n")
    h264_pts: list[str] = []
    other_pts: list[str] = []
    rtpmap: dict[str, str] = {}

    for line in lines:
        if line.startswith("a=rtpmap:"):
            body = line[len("a=rtpmap:") :]
            pt, rest = body.split(" ", 1)
            rtpmap[pt] = rest.split("/")[0].upper()

    out: list[str] = []
    for line in lines:
        if line.startswith("m=video "):
            parts = line.split()
            if len(parts) >= 4:
                pts = parts[3:]
                for pt in pts:
                    codec = rtpmap.get(pt, "")
                    if codec == "H264":
                        h264_pts.append(pt)
                    else:
                        other_pts.append(pt)
                if h264_pts:
                    parts[3:] = h264_pts + other_pts
                    line = " ".join(parts)
        out.append(line)

    body = "\r\n".join(out)
    if body and not body.endswith("\r\n"):
        body += "\r\n"
    return body


def cancel_ice_watch(session: PeerSession) -> None:
    task = session._ice_watch_task
    if task is not None:
        task.cancel()
        session._ice_watch_task = None


async def schedule_ice_failed_cleanup(session: PeerSession, delay: float) -> None:
    """Avoid tearing down Safari peers on transient ICE failed."""
    cancel_ice_watch(session)

    async def _watch() -> None:
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        pc = session.pc
        if session.id not in sessions:
            return
        if pc.iceConnectionState != "failed":
            return
        if pc.connectionState == "connected":
            logging.info("peer %s ICE failed but PC connected — keeping", session.label)
            return
        await cleanup_peer(session, "ice-failed")

    session._ice_watch_task = asyncio.create_task(_watch())


async def prime_h264_keyframes(session: PeerSession) -> None:
    """iOS often shows black video until an IDR frame arrives."""
    if "H264" not in session.codec.upper():
        return
    for _ in range(10):
        if session.id not in sessions:
            return
        if session.pc.connectionState not in ("connected", "connecting"):
            return
        senders = session.pc.getSenders()
        if senders:
            request_sender_keyframe(senders[0])
        await asyncio.sleep(0.35)


async def cleanup_peer(session: PeerSession, reason: str) -> None:
    """Close one peer only — never touches other sessions."""
    cancel_ice_watch(session)
    peer_id = session.id
    pc = session.pc

    sessions.pop(peer_id, None)
    pcs.discard(pc)

    logging.info("peer %s cleanup: %s", session.label, reason)

    try:
        await pc.close()
    except Exception as exc:
        logging.debug("peer %s close: %s", peer_id, exc)

    log_active_peers("after cleanup")


def get_relayed_video_track() -> MediaStreamTrack:
    """Single screen capture → MediaRelay → per-viewer proxy track."""
    global shared_source, media_relay

    assert capture is not None
    if media_relay is None:
        media_relay = MediaRelay()
        shared_source = ScreenStreamTrack(capture)
        logging.info("shared screen track + MediaRelay started")
    return media_relay.subscribe(shared_source, buffered=False)


async def _send_meta_when_connected(session: PeerSession, channel) -> None:
    """Send stream meta only after ICE + DTLS are up (Safari/LTE)."""
    for _ in range(120):
        if session.id not in sessions:
            return
        if session.pc.connectionState == "connected":
            send_meta(channel, session, session.codec)
            return
        await asyncio.sleep(0.05)
    logging.warning("peer %s meta send timeout (connection not connected)", session.label)


async def apply_peer_bitrate(session: PeerSession) -> None:
    for _ in range(30):
        senders = session.pc.getSenders()
        if not senders:
            await asyncio.sleep(0.1)
            continue
        sender = senders[0]
        if set_sender_bitrate(sender, session.preset.bitrate):
            tuned = tune_h264_sender(sender, session.preset)
            logging.info(
                "peer %s bitrate=%d h264_tune=%s codec=%s",
                session.label,
                session.preset.bitrate,
                tuned,
                session.codec,
            )
            asyncio.create_task(prime_h264_keyframes(session))
            return
        await asyncio.sleep(0.1)


def send_meta(channel, session: PeerSession, codec: str) -> None:
    assert capture is not None
    geom = capture.get_geometry()
    sw, sh = pyautogui.size()
    channel.send(
        json.dumps(
            {
                "t": "meta",
                "peerId": session.id,
                "streamW": geom.stream_width,
                "streamH": geom.stream_height,
                "monitorW": geom.monitor_width,
                "monitorH": geom.monitor_height,
                "screenW": sw,
                "screenH": sh,
                "quality": session.preset.name,
                "fps": session.preset.fps,
                "bitrate": session.preset.bitrate,
                "codec": codec,
            }
        )
    )


def handle_peer_quality(raw: str, session: PeerSession) -> None:
    try:
        event = json.loads(raw)
    except json.JSONDecodeError:
        return
    if event.get("t") != "quality":
        return

    name = event.get("mode", DEFAULT_QUALITY)
    session.preset = get_preset(name)
    logging.info("peer %s quality -> %s", session.label, name)

    senders = session.pc.getSenders()
    if senders:
        set_sender_bitrate(senders[0], session.preset.bitrate)


def _read_client_file(path: Path, label: str) -> str:
    if not path.is_file():
        logging.error("%s not found: %s", label, path)
        raise FileNotFoundError(f"{label} not found: {path}")
    text = path.read_text(encoding="utf-8")
    logging.debug("served %s (%d bytes)", label, len(text.encode("utf-8")))
    return text


def validate_client_files() -> None:
    for path, name in ((INDEX_HTML, "index.html"), (CLIENT_JS, "client.js")):
        if path.is_file():
            logging.info("client file ok: %s", path)
        else:
            logging.error("client file MISSING: %s", path)
            raise FileNotFoundError(f"Required file missing: {path}")


async def index(request: web.Request) -> web.Response:
    logging.info("GET / from %s", request.remote)
    try:
        content = _read_client_file(INDEX_HTML, "index.html")
    except FileNotFoundError as exc:
        logging.exception("failed to load index.html")
        return web.Response(status=500, text=f"Server error: {exc}")
    logging.info("GET / -> index.html ok")
    return web.Response(content_type="text/html", text=content)


async def ice_config(request: web.Request) -> web.Response:
    logging.debug("GET /ice-config from %s", request.remote)
    return web.json_response(ice_servers_json())


async def javascript(request: web.Request) -> web.Response:
    logging.info("GET /client.js from %s", request.remote)
    try:
        content = _read_client_file(CLIENT_JS, "client.js")
    except FileNotFoundError as exc:
        logging.exception("failed to load client.js")
        return web.Response(status=500, text=f"Server error: {exc}")
    return web.Response(content_type="application/javascript", text=content)


async def offer(request: web.Request) -> web.Response:
    assert capture is not None

    params = await request.json()
    quality = params.get("quality", DEFAULT_QUALITY)
    mobile = bool(params.get("mobile"))
    safari = bool(params.get("safari") or params.get("ios"))
    if mobile and quality == "balanced":
        quality = "mobile"

    preset = get_preset(quality)
    maybe_upgrade_shared_capture(preset)

    offer_sdp = filter_sdp_candidates(params["sdp"])
    offer_ice = count_sdp_candidates(offer_sdp)
    remote = RTCSessionDescription(sdp=offer_sdp, type=params["type"])

    pc = RTCPeerConnection(configuration=ICE_CONFIGURATION)
    session = PeerSession(pc=pc, preset=preset, mobile=mobile, safari=safari)

    pcs.add(pc)
    sessions[session.id] = session

    h264_first = mobile or safari
    ice_fail_delay = 20.0 if safari else 10.0
    logging.info(
        "peer %s created mobile=%s safari=%s quality=%s h264=%s",
        session.label,
        mobile,
        safari,
        preset.name,
        h264_first,
    )
    log_active_peers("new peer")

    @pc.on("connectionstatechange")
    async def on_connectionstatechange() -> None:
        state = pc.connectionState
        logging.info("peer %s connectionState=%s", session.label, state)
        if state == "connected":
            cancel_ice_watch(session)
            await apply_peer_bitrate(session)
        elif state in ("failed", "closed"):
            cancel_ice_watch(session)
            await cleanup_peer(session, state)

    @pc.on("iceconnectionstatechange")
    async def on_iceconnectionstatechange() -> None:
        ice = pc.iceConnectionState
        logging.info("peer %s iceConnectionState=%s", session.label, ice)
        if ice in ("connected", "completed"):
            cancel_ice_watch(session)
        elif ice == "failed":
            await schedule_ice_failed_cleanup(session, ice_fail_delay)

    @pc.on("datachannel")
    def on_datachannel(channel) -> None:
        if channel.label != "input":
            return

        @channel.on("open")
        def on_open() -> None:
            logging.info("peer %s DataChannel open", session.label)
            asyncio.ensure_future(_send_meta_when_connected(session, channel))

        @channel.on("close")
        def on_close() -> None:
            logging.info("peer %s DataChannel closed", session.label)

        @channel.on("message")
        def on_message(message) -> None:
            if not isinstance(message, str):
                return
            if '"t":"quality"' in message or '"t": "quality"' in message:
                handle_peer_quality(message, session)
                return
            logging.debug("peer %s dc <= %s", session.label, message[:80])
            handle_message(message)

    session.video_track = get_relayed_video_track()
    sender = pc.addTrack(session.video_track)

    session.codec = prefer_sender_codecs(pc, sender, h264_first=h264_first)

    await pc.setRemoteDescription(remote)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    answer_sdp = filter_sdp_candidates(pc.localDescription.sdp)
    if h264_first:
        answer_sdp = prefer_h264_in_answer_sdp(answer_sdp)
    answer_ice = count_sdp_candidates(answer_sdp)
    negotiated = sdp_video_codec(answer_sdp)
    logging.info(
        "peer %s answer codec=%s negotiated=%s bitrate=%d fps=%d offer_ice=%s answer_ice=%s",
        session.label,
        session.codec,
        negotiated,
        preset.bitrate,
        preset.fps,
        offer_ice,
        answer_ice,
    )

    return web.Response(
        content_type="application/json",
        text=json.dumps(
            {
                "sdp": answer_sdp,
                "type": pc.localDescription.type,
                "quality": preset.name,
                "peerId": session.id,
                "codec": negotiated,
            }
        ),
    )


async def stats(_: web.Request) -> web.Response:
    data = {
        "ts": time.time(),
        "activePeers": len(pcs),
        "peers": [
            {
                "id": s.id,
                "mobile": s.mobile,
                "safari": s.safari,
                "quality": s.preset.name,
                "connection": s.pc.connectionState,
                "ice": s.pc.iceConnectionState,
            }
            for s in sessions.values()
        ],
    }
    if capture is not None:
        data["grabs"] = capture.stats_grabs
    if shared_source is not None:
        data["framesSent"] = shared_source.frames_sent
    return web.json_response(data)


async def on_shutdown(_: web.Application) -> None:
    for session in list(sessions.values()):
        await cleanup_peer(session, "shutdown")
    if capture is not None:
        capture.stop()


def main() -> None:
    global capture

    parser = argparse.ArgumentParser(description="Any-remote host")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument(
        "--quality",
        choices=["mobile", "low", "balanced", "high", "ultra"],
        default=DEFAULT_QUALITY,
    )
    parser.add_argument("--cert-file")
    parser.add_argument("--key-file")
    parser.add_argument("-v", "--verbose", action="count")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO)

    validate_client_files()

    preset = get_preset(args.quality)
    capture = ScreenCapture(preset)
    capture.start()
    bind_capture(capture)

    ssl_context = None
    if args.cert_file:
        ssl_context = ssl.SSLContext()
        ssl_context.load_cert_chain(args.cert_file, args.key_file)

    app = web.Application()
    app.on_shutdown.append(on_shutdown)
    app.router.add_get("/", index)
    app.router.add_get("/client.js", javascript)
    app.router.add_get("/ice-config", ice_config)
    app.router.add_get("/stats", stats)
    app.router.add_post("/offer", offer)

    logging.info("Host :%s capture=%s (multi-peer + MediaRelay)", args.port, preset.name)
    web.run_app(app, host=args.host, port=args.port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
