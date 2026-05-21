"""Apply remote control events on the host with pyautogui."""

from __future__ import annotations

import json
import logging
import sys

import pyautogui

from screen_track import ScreenCapture

logger = logging.getLogger("input")

pyautogui.FAILSAFE = False

_capture: ScreenCapture | None = None


def bind_capture(capture: ScreenCapture) -> None:
    global _capture
    _capture = capture


def handle_message(raw: str) -> None:
    try:
        event = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("invalid JSON: %s", raw)
        return

    kind = event.get("t")
    if kind == "meta":
        return
    if kind == "move":
        x, y = _to_screen(event["x"], event["y"])
        logger.debug("move norm=(%.4f,%.4f) -> screen=(%s,%s)", event["x"], event["y"], x, y)
        pyautogui.moveTo(x, y, _pause=False)
    elif kind == "click":
        x, y = _to_screen(event["x"], event["y"])
        button = event.get("button", "left")
        logger.info("click %s norm=(%.4f,%.4f) -> screen=(%s,%s)", button, event["x"], event["y"], x, y)
        pyautogui.click(x, y, button=button)
    elif kind == "keydown":
        key = _normalize_key(event.get("key", ""))
        if key:
            logger.debug("keydown %s", key)
            pyautogui.keyDown(key)
    elif kind == "keyup":
        key = _normalize_key(event.get("key", ""))
        if key:
            logger.debug("keyup %s", key)
            pyautogui.keyUp(key)
    else:
        logger.debug("ignored event: %s", kind)


def _normalize_key(key: str) -> str:
    if not key:
        return ""
    if sys.platform == "darwin" and key in ("win", "meta", "command"):
        return "command"
    return key


def _to_screen(x_norm: float, y_norm: float) -> tuple[int, int]:
    """
    Map 0–1 coords (fraction of streamed desktop) to pyautogui logical screen coords.
    Handles macOS Retina when mss pixel size differs from pyautogui.size().
    """
    x_norm = max(0.0, min(1.0, float(x_norm)))
    y_norm = max(0.0, min(1.0, float(y_norm)))

    logical_w, logical_h = pyautogui.size()

    if _capture is not None:
        geom = _capture.get_geometry()
        mon_w, mon_h = geom.monitor_width, geom.monitor_height
        if mon_w > 0 and mon_h > 0 and (mon_w != logical_w or mon_h != logical_h):
            x = int(x_norm * (mon_w - 1) * logical_w / mon_w)
            y = int(y_norm * (mon_h - 1) * logical_h / mon_h)
            return x, y

    x = int(x_norm * max(logical_w - 1, 0))
    y = int(y_norm * max(logical_h - 1, 0))
    return x, y
