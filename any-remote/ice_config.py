"""STUN + TURN (Metered) and SDP candidate filtering for public-internet WebRTC."""

from __future__ import annotations

import ipaddress
import logging
import os
from typing import Any

from aiortc.rtcconfiguration import RTCConfiguration, RTCIceServer

logger = logging.getLogger("ice")

# Override via environment on the host; browser loads the same list from GET /ice-config.
TURN_USERNAME = os.environ.get("TURN_USERNAME", "bd8989604d98ccf84f5bd12f")
TURN_CREDENTIAL = os.environ.get("TURN_CREDENTIAL", "ZEq6ndSozfIK+IqK")

ICE_SERVERS_BROWSER: list[dict[str, Any]] = [
    {"urls": "stun:stun.relay.metered.ca:80"},
    {
        "urls": "turn:standard.relay.metered.ca:80",
        "username": TURN_USERNAME,
        "credential": TURN_CREDENTIAL,
    },
    {
        "urls": "turn:standard.relay.metered.ca:80?transport=tcp",
        "username": TURN_USERNAME,
        "credential": TURN_CREDENTIAL,
    },
    {
        "urls": "turn:standard.relay.metered.ca:443",
        "username": TURN_USERNAME,
        "credential": TURN_CREDENTIAL,
    },
    {
        "urls": "turns:standard.relay.metered.ca:443?transport=tcp",
        "username": TURN_USERNAME,
        "credential": TURN_CREDENTIAL,
    },
]

_USABLE_TYPES = frozenset({"srflx", "relay", "prflx"})


def _to_rtc_ice_server(entry: dict[str, Any]) -> RTCIceServer:
    urls = entry["urls"]
    kwargs: dict[str, Any] = {"urls": urls}
    if "username" in entry:
        kwargs["username"] = entry["username"]
    if "credential" in entry:
        kwargs["credential"] = entry["credential"]
    return RTCIceServer(**kwargs)


ICE_CONFIGURATION = RTCConfiguration(
    iceServers=[_to_rtc_ice_server(s) for s in ICE_SERVERS_BROWSER],
)


def ice_servers_json() -> dict[str, list[dict[str, Any]]]:
    """Payload for GET /ice-config (browser RTCPeerConnection)."""
    return {"iceServers": ICE_SERVERS_BROWSER}


def count_sdp_candidates(sdp: str) -> dict[str, int]:
    counts = {"host": 0, "srflx": 0, "relay": 0, "prflx": 0, "other": 0}
    for line in sdp.replace("\r\n", "\n").split("\n"):
        if not line.startswith("a=candidate:"):
            continue
        parsed = _parse_candidate(line)
        if not parsed:
            counts["other"] += 1
            continue
        _, typ = parsed
        counts[typ] = counts.get(typ, 0) + 1
    return counts


def _parse_candidate(line: str) -> tuple[str, str] | None:
    if not line.startswith("a=candidate:"):
        return None
    parts = line[len("a=candidate:") :].split()
    if len(parts) < 8:
        return None
    try:
        typ_index = parts.index("typ")
        return parts[4], parts[typ_index + 1]
    except ValueError:
        return None


def _is_unusable_address(ip: str) -> bool:
    if ip.endswith(".local"):
        return True
    try:
        addr = ipaddress.ip_address(ip.split("%")[0])
    except ValueError:
        return True
    return bool(
        addr.is_loopback
        or addr.is_private
        or addr.is_link_local
        or addr.is_unspecified
        or addr.is_multicast
    )


def keep_candidate_line(line: str) -> bool:
    """Drop host/local; keep srflx, relay (TURN), and prflx."""
    parsed = _parse_candidate(line)
    if parsed is None:
        return True

    ip, typ = parsed

    if typ == "host":
        return False
    if typ in _USABLE_TYPES:
        return True
    if _is_unusable_address(ip):
        return False
    return False


def filter_sdp_candidates(sdp: str) -> str:
    """Remove host/local ICE candidates from SDP; keep srflx and relay."""
    kept = 0
    dropped = 0
    out: list[str] = []

    for line in sdp.replace("\r\n", "\n").split("\n"):
        if line.startswith("a=candidate:"):
            if keep_candidate_line(line):
                out.append(line)
                kept += 1
            else:
                dropped += 1
        else:
            out.append(line)

    logger.debug("SDP ICE filter: kept=%s dropped=%s", kept, dropped)
    body = "\r\n".join(out)
    if body and not body.endswith("\r\n"):
        body += "\r\n"
    return body
