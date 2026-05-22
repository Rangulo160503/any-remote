"""ICE transport policy and SDP filtering per client platform."""

from __future__ import annotations

from ice_config import filter_sdp_candidates, keep_candidate_line


def host_uses_relay_only(mobile: bool, safari: bool, force_relay: bool = False) -> bool:
    return force_relay or (mobile and safari)


def filter_sdp_for_peer(sdp: str, *, relay_only: bool) -> str:
    if not relay_only:
        return filter_sdp_candidates(sdp)
    return filter_sdp_relay_only(sdp)


def filter_sdp_relay_only(sdp: str) -> str:
    """Keep only TURN relay candidates (Safari mobile production path)."""
    out: list[str] = []
    for line in sdp.replace("\r\n", "\n").split("\n"):
        if line.startswith("a=candidate:"):
            parsed = _parse_typ(line)
            if parsed == "relay":
                out.append(line)
            continue
        out.append(line)
    body = "\r\n".join(out)
    if body and not body.endswith("\r\n"):
        body += "\r\n"
    return body


def _parse_typ(line: str) -> str | None:
    if not line.startswith("a=candidate:"):
        return None
    parts = line[len("a=candidate:") :].split()
    try:
        return parts[parts.index("typ") + 1]
    except ValueError:
        return None


def client_ice_transport_policy(mobile: bool, safari: bool) -> str:
    """Browser RTCPeerConnection.iceTransportPolicy."""
    if mobile and safari:
        return "relay"
    return "all"
