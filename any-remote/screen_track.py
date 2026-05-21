"""Screen capture (mss) exposed as an aiortc VideoStreamTrack."""

from __future__ import annotations

import asyncio
import fractions
import logging
import threading
import time
from typing import Optional

import numpy as np
from aiortc import VideoStreamTrack
from aiortc.mediastreams import MediaStreamError
from av import VideoFrame
from mss import mss
from PIL import Image

logger = logging.getLogger("screen_track")

VIDEO_CLOCK_RATE = 90000
TARGET_FPS = 18
FRAME_PERIOD = 1 / TARGET_FPS
MAX_WIDTH = 1280
MAX_HEIGHT = 720


class CaptureGeometry:
    """Native monitor size (mss) and encoded stream size sent to the browser."""

    __slots__ = ("monitor_width", "monitor_height", "stream_width", "stream_height")

    def __init__(self) -> None:
        self.monitor_width = 0
        self.monitor_height = 0
        self.stream_width = MAX_WIDTH
        self.stream_height = MAX_HEIGHT


class ScreenCapture:
    """Background thread grabs the primary monitor at ~TARGET_FPS."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._frame: Optional[np.ndarray] = None
        self._geometry = CaptureGeometry()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="screen-capture", daemon=True)

    @property
    def size(self) -> tuple[int, int]:
        with self._lock:
            return self._geometry.stream_width, self._geometry.stream_height

    def get_geometry(self) -> CaptureGeometry:
        with self._lock:
            g = CaptureGeometry()
            g.monitor_width = self._geometry.monitor_width
            g.monitor_height = self._geometry.monitor_height
            g.stream_width = self._geometry.stream_width
            g.stream_height = self._geometry.stream_height
            return g

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)

    def get_frame(self) -> Optional[np.ndarray]:
        with self._lock:
            if self._frame is None:
                return None
            return self._frame.copy()

    def _run(self) -> None:
        interval = FRAME_PERIOD
        with mss() as sct:
            monitor = sct.monitors[1]
            with self._lock:
                self._geometry.monitor_width = monitor["width"]
                self._geometry.monitor_height = monitor["height"]
            logger.info(
                "capture monitor %sx%s (stream max %sx%s)",
                monitor["width"],
                monitor["height"],
                MAX_WIDTH,
                MAX_HEIGHT,
            )

            while not self._stop.is_set():
                t0 = time.perf_counter()
                try:
                    shot = sct.grab(monitor)
                    img = Image.frombytes("RGB", shot.size, shot.rgb)
                    img.thumbnail((MAX_WIDTH, MAX_HEIGHT), Image.Resampling.BILINEAR)
                    arr = np.asarray(img)
                    with self._lock:
                        self._frame = arr
                        self._geometry.stream_width = img.width
                        self._geometry.stream_height = img.height
                except Exception:
                    logger.exception("screen grab failed")
                elapsed = time.perf_counter() - t0
                time.sleep(max(0, interval - elapsed))


class ScreenStreamTrack(VideoStreamTrack):
    """Feeds the latest mss frame into WebRTC at TARGET_FPS."""

    kind = "video"

    def __init__(self, capture: ScreenCapture) -> None:
        super().__init__()
        self._capture = capture
        self._start: float = 0.0
        self._timestamp = 0

    async def recv(self) -> VideoFrame:
        if self.readyState != "live":
            raise MediaStreamError

        pts, time_base = await self._next_timestamp()
        arr = self._capture.get_frame()
        if arr is None:
            arr = np.zeros((480, 640, 3), dtype=np.uint8)

        frame = VideoFrame.from_ndarray(arr, format="rgb24")
        frame.pts = pts
        frame.time_base = time_base
        return frame

    async def _next_timestamp(self) -> tuple[int, fractions.Fraction]:
        if self.readyState != "live":
            raise MediaStreamError

        if self._timestamp:
            self._timestamp += int(FRAME_PERIOD * VIDEO_CLOCK_RATE)
            wait = self._start + (self._timestamp / VIDEO_CLOCK_RATE) - time.time()
            await asyncio.sleep(max(0, wait))
        else:
            self._start = time.time()
            self._timestamp = 0

        return self._timestamp, fractions.Fraction(1, VIDEO_CLOCK_RATE)
