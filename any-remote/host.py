"""
PC CASA — controlled host.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import ssl
import time

import pyautogui
from aiohttp import web
from aiortc import RTCPeerConnection, RTCRtpSender, RTCSessionDescription

from ice_config import ICE_CONFIGURATION, filter_sdp_candidates
from input_handler import bind_capture, handle_message
from screen_track import ScreenCapture, ScreenStreamTrack
from stream_config import DEFAULT_QUALITY, get_preset

ROOT = os.path.dirname(os.path.abspath(__file__))
CLIENT = os.path.join(ROOT, "client")

pcs: set[RTCPeerConnection] = set()
capture: ScreenCapture | None = None
current_preset = get_preset(DEFAULT_QUALITY)
video_track: ScreenStreamTrack | None = None


def force_codec(pc: RTCPeerConnection, sender: RTCRtpSender, mime: str) -> None:
    kind = mime.split("/")[0]
    codecs = RTCRtpSender.getCapabilities(kind).codecs
    transceiver = next(t for t in pc.getTransceivers() if t.sender == sender)
    transceiver.setCodecPreferences([c for c in codecs if c.mimeType == mime])


def set_sender_bitrate(sender: RTCRtpSender, bitrate: int) -> bool:
    enc = getattr(sender, "_RTCRtpSender__encoder", None)
    if enc is not None and hasattr(enc, "target_bitrate"):
        enc.target_bitrate = bitrate
        logging.info("encoder bitrate -> %d bps", bitrate)
        return True
    return False


async def index(_: web.Request) -> web.Response:
    with open(os.path.join(CLIENT, "index.html"), encoding="utf-8") as f:
        return web.Response(content_type="text/html", text=f.read())


async def javascript(_: web.Request) -> web.Response:
    with open(os.path.join(CLIENT, "client.js"), encoding="utf-8") as f:
        return web.Response(content_type="application/javascript", text=f.read())


def handle_quality_message(raw: str) -> None:
    global current_preset
    try:
        event = json.loads(raw)
    except json.JSONDecodeError:
        return
    if event.get("t") != "quality":
        return
    name = event.get("mode", DEFAULT_QUALITY)
    preset = get_preset(name)
    current_preset = preset
    if capture is not None:
        capture.apply_preset(preset)


async def offer(request: web.Request) -> web.Response:
    global current_preset, video_track

    assert capture is not None
    params = await request.json()

    quality = params.get("quality", DEFAULT_QUALITY)
    if params.get("mobile"):
        quality = "mobile"
        logging.info("mobile client detected — using mobile preset")
    current_preset = get_preset(quality)
    capture.apply_preset(current_preset)

    offer_sdp = filter_sdp_candidates(params["sdp"])
    offer = RTCSessionDescription(sdp=offer_sdp, type=params["type"])

    pc = RTCPeerConnection(configuration=ICE_CONFIGURATION)
    pcs.add(pc)

    @pc.on("connectionstatechange")
    async def on_connectionstatechange() -> None:
        logging.info("connection state: %s", pc.connectionState)
        if pc.connectionState == "connected":
            for _ in range(20):
                sender = pc.getSenders()[0] if pc.getSenders() else None
                if sender and set_sender_bitrate(sender, current_preset.bitrate):
                    break
                await asyncio.sleep(0.1)
        if pc.connectionState in ("failed", "closed"):
            await pc.close()
            pcs.discard(pc)

    @pc.on("datachannel")
    def on_datachannel(channel) -> None:
        if channel.label != "input":
            return

        @channel.on("open")
        def on_open() -> None:
            logging.info("DataChannel open")
            geom = capture.get_geometry()
            sw, sh = pyautogui.size()
            channel.send(
                json.dumps(
                    {
                        "t": "meta",
                        "streamW": geom.stream_width,
                        "streamH": geom.stream_height,
                        "monitorW": geom.monitor_width,
                        "monitorH": geom.monitor_height,
                        "screenW": sw,
                        "screenH": sh,
                        "quality": current_preset.name,
                        "fps": current_preset.fps,
                        "bitrate": current_preset.bitrate,
                    }
                )
            )

        @channel.on("close")
        def on_close() -> None:
            logging.info("DataChannel closed")

        @channel.on("message")
        def on_message(message) -> None:
            if not isinstance(message, str):
                return
            if '"t":"quality"' in message or '"t": "quality"' in message:
                handle_quality_message(message)
                logging.info("quality change requested (capture updated)")
                return
            logging.debug("DataChannel <= %s", message[:100])
            handle_message(message)

    video_track = ScreenStreamTrack(capture)
    sender = pc.addTrack(video_track)
    codec = "video/H264" if params.get("mobile") else "video/VP8"
    force_codec(pc, sender, codec)

    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    answer_sdp = filter_sdp_candidates(pc.localDescription.sdp)
    logging.info("answer ready quality=%s codec=%s", current_preset.name, codec)

    return web.Response(
        content_type="application/json",
        text=json.dumps(
            {
                "sdp": answer_sdp,
                "type": pc.localDescription.type,
                "quality": current_preset.name,
            }
        ),
    )


async def stats(_: web.Request) -> web.Response:
    """Optional host stats JSON for debugging."""
    data = {"ts": time.time()}
    if capture is not None:
        data["grabs"] = capture.stats_grabs
    if video_track is not None:
        data["sent"] = video_track.frames_sent
        data["skipped"] = video_track.frames_skipped
    return web.json_response(data)


async def on_shutdown(_: web.Application) -> None:
    await asyncio.gather(*[pc.close() for pc in list(pcs)], return_exceptions=True)
    pcs.clear()
    if capture is not None:
        capture.stop()


def main() -> None:
    global capture

    parser = argparse.ArgumentParser(description="Any-remote host")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument(
        "--quality",
        choices=["low", "balanced", "high"],
        default=DEFAULT_QUALITY,
    )
    parser.add_argument("--cert-file")
    parser.add_argument("--key-file")
    parser.add_argument("-v", "--verbose", action="count")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO)

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

    logging.info("Host :%s quality=%s (STUN + VP8)", args.port, preset.name)
    web.run_app(app, host=args.host, port=args.port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
