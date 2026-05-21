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

from stream_config import QualityPreset, get_preset

logger = logging.getLogger("screen_track")

VIDEO_CLOCK_RATE = 90000


class CaptureGeometry:
    __slots__ = ("monitor_width", "monitor_height", "stream_width", "stream_height")

    def __init__(self) -> None:
        self.monitor_width = 0
        self.monitor_height = 0
        self.stream_width = 960
        self.stream_height = 540


class ScreenCapture:
    """Single-slot capture — always overwrites latest frame (no queue)."""

    def __init__(self, preset: QualityPreset) -> None:
        self._preset = preset
        self.fps = preset.fps
        self._interval = 1.0 / preset.fps
        self._lock = threading.Lock()
        self._frame: Optional[np.ndarray] = None
        self._frame_seq = 0
        self._geometry = CaptureGeometry()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="screen-capture", daemon=True)
        self.stats_grabs = 0
        self.stats_dropped = 0

    def apply_preset(self, preset: QualityPreset) -> None:
        with self._lock:
            self._preset = preset
            self.fps = preset.fps
            self._interval = 1.0 / preset.fps
        logger.info("capture preset -> %s (%sx%s @ %d fps)", preset.name, preset.max_width, preset.max_height, preset.fps)

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
        with self._lock:
            if self._frame is None:
                return None, 0
            return self._frame.copy(), self._frame_seq

    def _resize_rgb(
        self, rgb: bytes, width: int, height: int, max_w: int, max_h: int, resample: Image.Resampling
    ) -> np.ndarray:
        if width <= max_w and height <= max_h:
            return np.frombuffer(rgb, dtype=np.uint8).reshape(height, width, 3).copy()
        img = Image.frombytes("RGB", (width, height), rgb)
        img.thumbnail((max_w, max_h), resample)
        return np.asarray(img)

    def _run(self) -> None:
        with mss() as sct:
            monitor = sct.monitors[1]
            with self._lock:
                self._geometry.monitor_width = monitor["width"]
                self._geometry.monitor_height = monitor["height"]
                preset = self._preset
            logger.info(
                "capture %sx%s → %s max %sx%s @ %d FPS",
                monitor["width"],
                monitor["height"],
                preset.name,
                preset.max_width,
                preset.max_height,
                preset.fps,
            )

            while not self._stop.is_set():
                t0 = time.perf_counter()
                with self._lock:
                    preset = self._preset
                try:
                    shot = sct.grab(monitor)
                    w, h = shot.size
                    arr = self._resize_rgb(
                        shot.rgb, w, h, preset.max_width, preset.max_height, preset.resample
                    )
                    with self._lock:
                        self._frame = arr
                        self._frame_seq += 1
                        self._geometry.stream_width = arr.shape[1]
                        self._geometry.stream_height = arr.shape[0]
                        self.stats_grabs += 1
                except Exception:
                    logger.exception("screen grab failed")

                elapsed = time.perf_counter() - t0
                with self._lock:
                    interval = self._interval
                time.sleep(max(0.0, interval - elapsed))


class ScreenStreamTrack(VideoStreamTrack):
    """Latest frame only; wall-clock PTS; no send backlog."""

    kind = "video"

    def __init__(self, capture: ScreenCapture) -> None:
        super().__init__()
        self._capture = capture
        self._start = time.time()
        self._last_send = 0.0
        self._last_seq = -1
        self._black: Optional[np.ndarray] = None
        self.frames_sent = 0
        self.frames_skipped = 0

    @property
    def _min_interval(self) -> float:
        return 1.0 / max(1, self._capture.fps)

    async def recv(self) -> VideoFrame:
        if self.readyState != "live":
            raise MediaStreamError

        now = time.time()
        wait = self._min_interval - (now - self._last_send)
        if wait > 0:
            await asyncio.sleep(wait)

        arr, seq = self._capture.get_latest()
        if arr is None:
            if self._black is None:
                p = get_preset("balanced")
                self._black = np.zeros((p.max_height, p.max_width, 3), dtype=np.uint8)
            arr = self._black
        elif seq == self._last_seq:
            self.frames_skipped += 1

        self._last_seq = seq
        self._last_send = time.time()
        self.frames_sent += 1
        pts = int((self._last_send - self._start) * VIDEO_CLOCK_RATE)

        frame = VideoFrame.from_ndarray(arr, format="rgb24")
        frame.pts = pts
        frame.time_base = fractions.Fraction(1, VIDEO_CLOCK_RATE)
        return frame
