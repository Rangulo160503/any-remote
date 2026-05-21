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

from ice_config import ICE_CONFIGURATION, filter_sdp_candidates
from input_handler import bind_capture, handle_message
from peer_session import PeerSession
from screen_track import ScreenCapture, ScreenStreamTrack
from stream_config import DEFAULT_QUALITY, QualityPreset, get_preset

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


def force_codec(pc: RTCPeerConnection, sender: RTCRtpSender, mime: str) -> None:
    kind = mime.split("/")[0]
    codecs = RTCRtpSender.getCapabilities(kind).codecs
    transceiver = next(t for t in pc.getTransceivers() if t.sender == sender)
    transceiver.setCodecPreferences([c for c in codecs if c.mimeType == mime])


def set_sender_bitrate(sender: RTCRtpSender, bitrate: int) -> bool:
    enc = getattr(sender, "_RTCRtpSender__encoder", None)
    if enc is not None and hasattr(enc, "target_bitrate"):
        enc.target_bitrate = bitrate
        return True
    return False


async def cleanup_peer(session: PeerSession, reason: str) -> None:
    """Close one peer only — never touches other sessions."""
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


async def apply_peer_bitrate(session: PeerSession) -> None:
    for _ in range(30):
        senders = session.pc.getSenders()
        if senders and set_sender_bitrate(senders[0], session.preset.bitrate):
            logging.info(
                "peer %s bitrate %d",
                session.label,
                session.preset.bitrate,
            )
            return
        await asyncio.sleep(0.1)


def send_meta(channel, session: PeerSession) -> None:
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
    if mobile:
        quality = "mobile"

    preset = get_preset(quality)

    offer_sdp = filter_sdp_candidates(params["sdp"])
    remote = RTCSessionDescription(sdp=offer_sdp, type=params["type"])

    pc = RTCPeerConnection(configuration=ICE_CONFIGURATION)
    session = PeerSession(pc=pc, preset=preset, mobile=mobile)

    pcs.add(pc)
    sessions[session.id] = session

    logging.info("peer %s created (mobile=%s quality=%s)", session.label, mobile, preset.name)
    log_active_peers("new peer")

    @pc.on("connectionstatechange")
    async def on_connectionstatechange() -> None:
        state = pc.connectionState
        logging.info("peer %s connectionState=%s", session.label, state)
        if state == "connected":
            await apply_peer_bitrate(session)
        elif state in ("failed", "closed"):
            await cleanup_peer(session, state)

    @pc.on("iceconnectionstatechange")
    async def on_iceconnectionstatechange() -> None:
        logging.info(
            "peer %s iceConnectionState=%s",
            session.label,
            pc.iceConnectionState,
        )
        if pc.iceConnectionState == "failed":
            await cleanup_peer(session, "ice-failed")

    @pc.on("datachannel")
    def on_datachannel(channel) -> None:
        if channel.label != "input":
            return

        @channel.on("open")
        def on_open() -> None:
            logging.info("peer %s DataChannel open", session.label)
            send_meta(channel, session)

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

    codec = "video/H264" if mobile else "video/VP8"
    force_codec(pc, sender, codec)

    await pc.setRemoteDescription(remote)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    answer_sdp = filter_sdp_candidates(pc.localDescription.sdp)
    logging.info("peer %s answer ready codec=%s", session.label, codec)

    return web.Response(
        content_type="application/json",
        text=json.dumps(
            {
                "sdp": answer_sdp,
                "type": pc.localDescription.type,
                "quality": preset.name,
                "peerId": session.id,
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
    parser.add_argument("--quality", choices=["low", "balanced", "high", "mobile"], default=DEFAULT_QUALITY)
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
    app.router.add_get("/stats", stats)
    app.router.add_post("/offer", offer)

    logging.info("Host :%s capture=%s (multi-peer + MediaRelay)", args.port, preset.name)
    web.run_app(app, host=args.host, port=args.port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
