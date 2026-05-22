"""Per-peer adaptive quality (bitrate / preset) from client network stats."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Callable

from stream_config import QualityPreset, get_preset

if TYPE_CHECKING:
    from peer_session import PeerSession

logger = logging.getLogger("quality.adapt")

SetBitrateFn = Callable[["PeerSession", int], bool]


def parse_adapt_event(raw: str) -> dict | None:
    import json

    try:
        event = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if event.get("t") not in ("adapt", "quality"):
        return None
    return event


def apply_peer_adaptation(
    session: "PeerSession",
    event: dict,
    *,
    set_bitrate: SetBitrateFn,
    upgrade_capture: Callable[[QualityPreset], None] | None = None,
) -> None:
    mode = event.get("mode")
    if mode:
        session.preset = get_preset(mode)
        session.adaptive_mode = mode

    bitrate = event.get("bitrate")
    if isinstance(bitrate, (int, float)) and bitrate > 0:
        session.target_bitrate = int(bitrate)
        set_bitrate(session, int(bitrate))

    fps = event.get("fps")
    if isinstance(fps, (int, float)) and fps > 0:
        session.target_fps = int(fps)

    loss = event.get("packetLoss")
    if isinstance(loss, (int, float)):
        session.last_packet_loss = float(loss)

    rtt = event.get("rtt")
    if isinstance(rtt, (int, float)):
        session.last_rtt_ms = float(rtt)

    if upgrade_capture and mode:
        upgrade_capture(session.preset)

    logger.info(
        "peer %s adapt mode=%s bitrate=%s fps=%s loss=%s rtt=%s",
        session.label,
        session.preset.name,
        getattr(session, "target_bitrate", session.preset.bitrate),
        getattr(session, "target_fps", session.preset.fps),
        getattr(session, "last_packet_loss", None),
        getattr(session, "last_rtt_ms", None),
    )
