"""STUN configuration and SDP candidate filtering for public-internet WebRTC."""

from __future__ import annotations

import ipaddress
import logging

from aiortc.rtcconfiguration import RTCConfiguration, RTCIceServer

logger = logging.getLogger("ice")

STUN_URL = "stun:stun.l.google.com:19302"

ICE_CONFIGURATION = RTCConfiguration(
    iceServers=[RTCIceServer(urls=STUN_URL)],
)

# Candidate types that work across NAT without TURN.
_USABLE_TYPES = frozenset({"srflx", "relay", "prflx"})


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
    """Keep only reflexive (and future relay) candidates; drop host/local."""
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
    """Remove host/local ICE candidates from SDP; keep srflx (and relay when added)."""
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
