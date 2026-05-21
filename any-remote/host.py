"""
PC CASA — controlled host.

Serves the browser UI + WebRTC signaling. Streams the desktop (mss → aiortc)
and applies remote input from the DataChannel (pyautogui).

Run: python host.py
Then on PC AFZ open: http://<casa-tailscale-ip>:8080
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import ssl

from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription

from screen_track import ScreenCapture, ScreenStreamTrack
from input_handler import handle_message

ROOT = os.path.dirname(os.path.abspath(__file__))
CLIENT = os.path.join(ROOT, "client")

pcs: set[RTCPeerConnection] = set()
capture = ScreenCapture()


async def index(_: web.Request) -> web.Response:
    with open(os.path.join(CLIENT, "index.html"), encoding="utf-8") as f:
        return web.Response(content_type="text/html", text=f.read())


async def javascript(_: web.Request) -> web.Response:
    with open(os.path.join(CLIENT, "client.js"), encoding="utf-8") as f:
        return web.Response(content_type="application/javascript", text=f.read())


async def offer(request: web.Request) -> web.Response:
    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    pc = RTCPeerConnection()
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
        logging.info("input datachannel open from controller")

        @channel.on("message")
        def on_message(message) -> None:
            if isinstance(message, str):
                handle_message(message)

    pc.addTrack(ScreenStreamTrack(capture))

    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return web.Response(
        content_type="application/json",
        text=json.dumps(
            {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}
        ),
    )


async def on_shutdown(_: web.Application) -> None:
    await asyncio.gather(*[pc.close() for pc in list(pcs)], return_exceptions=True)
    pcs.clear()
    capture.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description="Any-remote host (PC CASA)")
    parser.add_argument("--host", default="0.0.0.0", help="HTTP bind address")
    parser.add_argument("--port", type=int, default=8080, help="HTTP port")
    parser.add_argument("--cert-file", help="SSL certificate (optional HTTPS)")
    parser.add_argument("--key-file", help="SSL key file")
    parser.add_argument("-v", "--verbose", action="count")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO)

    capture.start()

    ssl_context = None
    if args.cert_file:
        ssl_context = ssl.SSLContext()
        ssl_context.load_cert_chain(args.cert_file, args.key_file)

    app = web.Application()
    app.on_shutdown.append(on_shutdown)
    app.router.add_get("/", index)
    app.router.add_get("/client.js", javascript)
    app.router.add_post("/offer", offer)

    logging.info("Host ready — controller opens http://<tailscale-ip>:%s", args.port)
    web.run_app(app, host=args.host, port=args.port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
