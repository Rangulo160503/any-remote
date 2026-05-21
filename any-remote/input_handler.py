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
_drag_button: str | None = None


def bind_capture(capture: ScreenCapture) -> None:
    global _capture
    _capture = capture


def handle_message(raw: str) -> None:
    global _drag_button

    try:
        event = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("invalid JSON: %s", raw)
        return

    kind = event.get("t")
    if kind == "meta":
        return

    if kind == "down":
        _handle_down(event)
    elif kind == "move":
        _handle_move(event)
    elif kind == "up":
        _handle_up(event)
    elif kind == "click":
        _handle_click(event)
    elif kind == "keydown":
        key = _normalize_key(event.get("key", ""))
        if key:
            pyautogui.keyDown(key)
    elif kind == "keyup":
        key = _normalize_key(event.get("key", ""))
        if key:
            pyautogui.keyUp(key)
    else:
        logger.debug("ignored event: %s", kind)


def _handle_down(event: dict) -> None:
    global _drag_button

    button = _normalize_button(event.get("button", "left"))
    x, y = _to_screen(event["x"], event["y"])
    _drag_button = button
    logger.info("mouseDown %s -> (%s, %s)", button, x, y)
    pyautogui.moveTo(x, y, _pause=False)
    pyautogui.mouseDown(x, y, button=button)


def _handle_move(event: dict) -> None:
    x, y = _to_screen(event["x"], event["y"])
    if _drag_button:
        logger.debug("drag move (%s, %s) btn=%s", x, y, _drag_button)
    pyautogui.moveTo(x, y, _pause=False)


def _handle_up(event: dict) -> None:
    global _drag_button

    button = _normalize_button(event.get("button", _drag_button or "left"))
    x, y = _to_screen(event["x"], event["y"])
    logger.info("mouseUp %s -> (%s, %s)", button, x, y)
    pyautogui.moveTo(x, y, _pause=False)
    pyautogui.mouseUp(x, y, button=button)
    _drag_button = None


def _handle_click(event: dict) -> None:
    """Legacy one-shot click (down+up at same point)."""
    button = _normalize_button(event.get("button", "left"))
    x, y = _to_screen(event["x"], event["y"])
    logger.info("click %s -> (%s, %s)", button, x, y)
    pyautogui.click(x, y, button=button)


def _normalize_button(button: str) -> str:
    if button in ("left", "right", "middle"):
        return button
    return "left"


def _normalize_key(key: str) -> str:
    if not key:
        return ""
    if sys.platform == "darwin" and key in ("win", "meta", "command"):
        return "command"
    return key


def _to_screen(x_norm: float, y_norm: float) -> tuple[int, int]:
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
