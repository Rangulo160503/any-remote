"""Structured ICE / connection diagnostics logging."""

from __future__ import annotations

import logging
import time
from typing import Any

from ice_config import count_sdp_candidates

logger = logging.getLogger("ice.diag")


def log_sdp_candidates(peer_label: str, phase: str, sdp: str) -> dict[str, int]:
    counts = count_sdp_candidates(sdp)
    logger.info(
        "ice_diag peer=%s phase=%s candidates=%s",
        peer_label,
        phase,
        counts,
    )
    return counts


def log_peer_platform(
    peer_label: str,
    *,
    mobile: bool,
    safari: bool,
    client_meta: dict[str, Any] | None = None,
) -> None:
    meta = client_meta or {}
    logger.info(
        "ice_diag peer=%s platform mobile=%s safari=%s device=%s os=%s "
        "safari_ver=%s network=%s ice_policy=%s",
        peer_label,
        mobile,
        safari,
        meta.get("device", "unknown"),
        meta.get("os", "unknown"),
        meta.get("safariVersion", "—"),
        meta.get("networkType", "—"),
        meta.get("iceTransportPolicy", "—"),
    )


def log_selected_pair(peer_label: str, info: dict[str, Any]) -> None:
    logger.info(
        "ice_diag peer=%s selected_pair=%s local=%s remote=%s "
        "protocol=%s rtt_ms=%s",
        peer_label,
        info.get("summary", "—"),
        info.get("localType", "—"),
        info.get("remoteType", "—"),
        info.get("protocol", "—"),
        info.get("rttMs", "—"),
    )


def format_pair_summary(local_type: str, remote_type: str, protocol: str) -> str:
    lt = local_type or "unknown"
    rt = remote_type or "unknown"
    proto = (protocol or "udp").lower()
    if lt == "relay" or rt == "relay":
        return f"relay/{proto}"
    if lt == "srflx" or rt == "srflx":
        return "srflx"
    if lt == "host" or rt == "host":
        return "host"
    return f"{lt}/{rt}"
