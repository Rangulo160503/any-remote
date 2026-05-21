"""
PC CASA — controlled host.

Serves the browser UI + WebRTC signaling. Streams the desktop (mss → aiortc)
and applies remote input from the DataChannel (pyautogui).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import ssl

import pyautogui
from aiohttp import web
from aiortc import RTCPeerConnection, RTCRtpSender, RTCSessionDescription

from ice_config import ICE_CONFIGURATION, filter_sdp_candidates
from screen_track import (
    DEFAULT_FPS,
    HD_MAX_HEIGHT,
    HD_MAX_WIDTH,
    ScreenCapture,
    ScreenStreamTrack,
)
from input_handler import bind_capture, handle_message

ROOT = os.path.dirname(os.path.abspath(__file__))
CLIENT = os.path.join(ROOT, "client")

pcs: set[RTCPeerConnection] = set()
capture: ScreenCapture | None = None


def force_codec(pc: RTCPeerConnection, sender: RTCRtpSender, mime: str) -> None:
    kind = mime.split("/")[0]
    codecs = RTCRtpSender.getCapabilities(kind).codecs
    transceiver = next(t for t in pc.getTransceivers() if t.sender == sender)
    transceiver.setCodecPreferences([c for c in codecs if c.mimeType == mime])


async def index(_: web.Request) -> web.Response:
    with open(os.path.join(CLIENT, "index.html"), encoding="utf-8") as f:
        return web.Response(content_type="text/html", text=f.read())


async def javascript(_: web.Request) -> web.Response:
    with open(os.path.join(CLIENT, "client.js"), encoding="utf-8") as f:
        return web.Response(content_type="application/javascript", text=f.read())


async def offer(request: web.Request) -> web.Response:
    assert capture is not None
    params = await request.json()
    offer_sdp = filter_sdp_candidates(params["sdp"])
    offer = RTCSessionDescription(sdp=offer_sdp, type=params["type"])

    pc = RTCPeerConnection(configuration=ICE_CONFIGURATION)
    pcs.add(pc)

    @pc.on("connectionstatechange")
    async def on_connectionstatechange() -> None:
        logging.info("connection state: %s", pc.connectionState)
        if pc.connectionState in ("failed", "closed"):
            await pc.close()
            pcs.discard(pc)

    @pc.on("datachannel")
    def on_datachannel(channel) -> None:
        if channel.label != "input":
            return

        @channel.on("open")
        def on_open() -> None:
            logging.info("DataChannel open: %s", channel.label)
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
                    }
                )
            )

        @channel.on("close")
        def on_close() -> None:
            logging.info("DataChannel closed")

        @channel.on("message")
        def on_message(message) -> None:
            if isinstance(message, str):
                logging.debug("DataChannel <= %s", message[:120])
                handle_message(message)

    sender = pc.addTrack(ScreenStreamTrack(capture, fps=capture.fps))
    # VP8: realtime deadline, lag-in-frames=0 (lower latency than default)
    force_codec(pc, sender, "video/VP8")

    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    answer_sdp = filter_sdp_candidates(pc.localDescription.sdp)
    logging.info("ICE answer ready (VP8, low-latency capture)")

    return web.Response(
        content_type="application/json",
        text=json.dumps({"sdp": answer_sdp, "type": pc.localDescription.type}),
    )


async def on_shutdown(_: web.Application) -> None:
    await asyncio.gather(*[pc.close() for pc in list(pcs)], return_exceptions=True)
    pcs.clear()
    if capture is not None:
        capture.stop()


def main() -> None:
    global capture

    parser = argparse.ArgumentParser(description="Any-remote host (PC CASA)")
    parser.add_argument("--host", default="0.0.0.0", help="HTTP bind address")
    parser.add_argument("--port", type=int, default=8080, help="HTTP port")
    parser.add_argument(
        "--resolution",
        choices=["540p", "720p"],
        default="540p",
        help="540p=960x540 (default, low latency), 720p=1280x720",
    )
    parser.add_argument(
        "--fps",
        type=int,
        default=DEFAULT_FPS,
        choices=[12, 15, 18],
        help="Max capture/send FPS (default 12)",
    )
    parser.add_argument("--cert-file", help="SSL certificate (optional HTTPS)")
    parser.add_argument("--key-file", help="SSL key file")
    parser.add_argument("-v", "--verbose", action="count")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO)

    if args.resolution == "720p":
        max_w, max_h = HD_MAX_WIDTH, HD_MAX_HEIGHT
    else:
        max_w, max_h = 960, 540

    capture = ScreenCapture(max_width=max_w, max_height=max_h, fps=args.fps)
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
    app.router.add_post("/offer", offer)

    logging.info(
        "Host ready port=%s %s @ %d FPS (STUN + VP8 realtime)",
        args.port,
        args.resolution,
        args.fps,
    )
    web.run_app(app, host=args.host, port=args.port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
