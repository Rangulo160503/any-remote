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

from ice_config import ice_servers_json
from input_handler import bind_capture
import peer_manager
from peer_manager import client_index, handle_offer, pcs, sessions
from peer_session import PeerSession
from screen_track import ScreenCapture, ScreenStreamTrack
from stream_config import DEFAULT_QUALITY, QualityPreset, get_preset, max_preset

ROOT = Path(__file__).resolve().parent
CLIENT_DIR = ROOT / "client"
INDEX_HTML = CLIENT_DIR / "index.html"
CLIENT_JS = CLIENT_DIR / "client.js"

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
    session.state = "closed"

    if session.client_id and client_index.get(session.client_id) == peer_id:
        client_index.pop(session.client_id, None)

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


def set_bitrate_for_session(session: PeerSession, bitrate: int) -> bool:
    senders = session.pc.getSenders()
    if senders:
        return set_sender_bitrate(senders[0], bitrate)
    return False


def _read_client_file(path: Path, label: str) -> str:
    if not path.is_file():
        logging.error("%s not found: %s", label, path)
        raise FileNotFoundError(f"{label} not found: {path}")
    text = path.read_text(encoding="utf-8")
    logging.debug("served %s (%d bytes)", label, len(text.encode("utf-8")))
    return text


REQUIRED_CLIENT = (
    (INDEX_HTML, "index.html"),
    (CLIENT_DIR / "js" / "app.js", "js/app.js"),
    (CLIENT_DIR / "js" / "video-singleton.js", "js/video-singleton.js"),
    (CLIENT_DIR / "js" / "video-recovery.js", "js/video-recovery.js"),
    (CLIENT_DIR / "js" / "media-stream.js", "js/media-stream.js"),
    (CLIENT_DIR / "js" / "sdp-munge.js", "js/sdp-munge.js"),
    (CLIENT_DIR / "client.css", "client.css"),
    (CLIENT_JS, "client.js"),
)


def validate_client_files() -> None:
    for path, name in REQUIRED_CLIENT:
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
    mobile = request.query.get("mobile") == "1"
    safari = request.query.get("safari") == "1"
    logging.debug("GET /ice-config from %s mobile=%s safari=%s", request.remote, mobile, safari)
    return web.json_response(ice_servers_json(mobile=mobile, safari=safari))


def _serve_bytes(path: Path, ctype: str) -> web.Response:
    if not path.is_file():
        raise web.HTTPNotFound()
    return web.Response(body=path.read_bytes(), content_type=ctype)


async def serve_client_css(_: web.Request) -> web.Response:
    return _serve_bytes(CLIENT_DIR / "client.css", "text/css")


async def serve_client_js(request: web.Request) -> web.Response:
    rel = request.match_info.get("path", "")
    if ".." in rel:
        raise web.HTTPForbidden()
    return _serve_bytes(CLIENT_DIR / "js" / rel, "application/javascript")


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
    result = await handle_offer(params)
    return web.json_response(result)


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

    def request_keyframe_for_session(session: PeerSession) -> None:
        senders = session.pc.getSenders()
        if senders:
            request_sender_keyframe(senders[0])

    peer_manager.configure(
        get_relayed_track=get_relayed_video_track,
        maybe_upgrade_capture=maybe_upgrade_shared_capture,
        prefer_codecs=prefer_sender_codecs,
        prefer_h264_sdp=prefer_h264_in_answer_sdp,
        sdp_codec=sdp_video_codec,
        apply_bitrate=apply_peer_bitrate,
        set_bitrate=set_bitrate_for_session,
        send_meta=send_meta,
        send_meta_when_connected=_send_meta_when_connected,
        cancel_ice_watch=cancel_ice_watch,
        schedule_ice_failed=schedule_ice_failed_cleanup,
        cleanup_peer=cleanup_peer,
        request_keyframe=request_keyframe_for_session,
    )

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
    app.router.add_get("/client.css", serve_client_css)
    app.router.add_get(r"/js/{path:.+}", serve_client_js)
    app.router.add_get("/ice-config", ice_config)
    app.router.add_get("/stats", stats)
    app.router.add_post("/offer", offer)

    async def start_gc(_app: web.Application) -> None:
        async def loop() -> None:
            while True:
                await asyncio.sleep(30)
                await peer_manager.cleanup_stale_peers()

        asyncio.create_task(loop())

    app.on_startup.append(start_gc)

    logging.info("Host :%s capture=%s (multi-peer + MediaRelay)", args.port, preset.name)
    web.run_app(app, host=args.host, port=args.port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
