"""Screen capture (mss) → aiortc VideoStreamTrack. Latency-first: latest frame only."""

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

# Defaults: prioritize responsiveness
DEFAULT_MAX_WIDTH = 960
DEFAULT_MAX_HEIGHT = 540
HD_MAX_WIDTH = 1280
HD_MAX_HEIGHT = 720
DEFAULT_FPS = 12


class CaptureGeometry:
    __slots__ = ("monitor_width", "monitor_height", "stream_width", "stream_height")

    def __init__(self) -> None:
        self.monitor_width = 0
        self.monitor_height = 0
        self.stream_width = DEFAULT_MAX_WIDTH
        self.stream_height = DEFAULT_MAX_HEIGHT


class ScreenCapture:
    """
    Single-slot capture: always overwrites the latest frame (no queue).
    Capture thread never waits on the encoder.
    """

    def __init__(
        self,
        max_width: int = DEFAULT_MAX_WIDTH,
        max_height: int = DEFAULT_MAX_HEIGHT,
        fps: int = DEFAULT_FPS,
    ) -> None:
        self._max_width = max_width
        self._max_height = max_height
        self.fps = max(1, min(fps, 20))
        self._interval = 1.0 / self.fps
        self._lock = threading.Lock()
        self._frame: Optional[np.ndarray] = None
        self._frame_seq = 0
        self._geometry = CaptureGeometry()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="screen-capture", daemon=True)

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

    def get_latest(self) -> tuple[Optional[np.ndarray], int]:
        """Return (frame copy, sequence). Always the newest capture."""
        with self._lock:
            if self._frame is None:
                return None, 0
            return self._frame.copy(), self._frame_seq

    @staticmethod
    def _resize_rgb(rgb: bytes, width: int, height: int, max_w: int, max_h: int) -> np.ndarray:
        if width <= max_w and height <= max_h:
            return np.frombuffer(rgb, dtype=np.uint8).reshape(height, width, 3).copy()
        img = Image.frombytes("RGB", (width, height), rgb)
        img.thumbnail((max_w, max_h), Image.Resampling.BILINEAR)
        return np.asarray(img)

    def _run(self) -> None:
        with mss() as sct:
            monitor = sct.monitors[1]
            with self._lock:
                self._geometry.monitor_width = monitor["width"]
                self._geometry.monitor_height = monitor["height"]
            logger.info(
                "capture %sx%s → max %sx%s @ ~%d FPS",
                monitor["width"],
                monitor["height"],
                self._max_width,
                self._max_height,
                int(1 / self._interval),
            )

            while not self._stop.is_set():
                t0 = time.perf_counter()
                try:
                    shot = sct.grab(monitor)
                    w, h = shot.size
                    arr = self._resize_rgb(shot.rgb, w, h, self._max_width, self._max_height)
                    with self._lock:
                        self._frame = arr
                        self._frame_seq += 1
                        self._geometry.stream_width = arr.shape[1]
                        self._geometry.stream_height = arr.shape[0]
                except Exception:
                    logger.exception("screen grab failed")

                elapsed = time.perf_counter() - t0
                # Cap capture rate; if grab is slow, skip sleep (drop frames implicitly)
                time.sleep(max(0.0, self._interval - elapsed))


class ScreenStreamTrack(VideoStreamTrack):
    """
    Sends only the latest frame at a capped rate.
    Uses wall-clock PTS (no cumulative sleep backlog).
    """

    kind = "video"

    def __init__(self, capture: ScreenCapture, fps: int = DEFAULT_FPS) -> None:
        super().__init__()
        self._capture = capture
        self._min_interval = 1.0 / max(1, min(fps, 20))
        self._start = time.time()
        self._last_send = 0.0
        self._black: Optional[np.ndarray] = None

    async def recv(self) -> VideoFrame:
        if self.readyState != "live":
            raise MediaStreamError

        now = time.time()
        wait = self._min_interval - (now - self._last_send)
        if wait > 0:
            await asyncio.sleep(wait)

        arr, _seq = self._capture.get_latest()
        if arr is None:
            if self._black is None:
                self._black = np.zeros((DEFAULT_MAX_HEIGHT, DEFAULT_MAX_WIDTH, 3), dtype=np.uint8)
            arr = self._black

        self._last_send = time.time()
        pts = int((self._last_send - self._start) * VIDEO_CLOCK_RATE)

        frame = VideoFrame.from_ndarray(arr, format="rgb24")
        frame.pts = pts
        frame.time_base = fractions.Fraction(1, VIDEO_CLOCK_RATE)
        return frame
