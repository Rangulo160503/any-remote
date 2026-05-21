"""Apply remote control events on the host with pyautogui."""

from __future__ import annotations

import json
import logging

import pyautogui

logger = logging.getLogger("input")

# Remote control should not abort when the cursor hits a screen corner.
pyautogui.FAILSAFE = False


def handle_message(raw: str) -> None:
    try:
        event = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("invalid JSON: %s", raw)
        return

    kind = event.get("t")
    if kind == "move":
        _move(event["x"], event["y"])
    elif kind == "click":
        _click(event["x"], event["y"], event.get("button", "left"))
    else:
        logger.debug("ignored event: %s", kind)


def _move(x_norm: float, y_norm: float) -> None:
    x, y = _to_screen(x_norm, y_norm)
    pyautogui.moveTo(x, y, _pause=False)


def _click(x_norm: float, y_norm: float, button: str) -> None:
    x, y = _to_screen(x_norm, y_norm)
    pyautogui.click(x, y, button=button)


def _to_screen(x_norm: float, y_norm: float) -> tuple[int, int]:
    width, height = pyautogui.size()
    x = int(max(0.0, min(1.0, x_norm)) * (width - 1))
    y = int(max(0.0, min(1.0, y_norm)) * (height - 1))
    return x, y
