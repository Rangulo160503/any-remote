"""Peer lifecycle: signaling, ICE policy, cleanup, deduplication, GC."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Callable, Optional

from aiohttp import web
from aiortc import RTCPeerConnection, RTCRtpSender, RTCSessionDescription

from ice_config import ICE_CONFIGURATION, ice_servers_json
from ice_diagnostics import log_peer_platform, log_sdp_candidates
from ice_policy import filter_sdp_for_peer, host_uses_relay_only
from input_handler import handle_message
from peer_session import PeerSession
from quality_adaptation import apply_peer_adaptation, parse_adapt_event
from stream_config import DEFAULT_QUALITY, QualityPreset, get_preset

logger = logging.getLogger("peer.manager")

# Injected by host at startup
pcs: set[RTCPeerConnection] = set()
sessions: dict[str, PeerSession] = {}
client_index: dict[str, str] = {}  # client_id -> peer_id

_get_relayed_track: Callable[[], object] | None = None
_maybe_upgrade_capture: Callable[[QualityPreset], None] | None = None
_prefer_codecs: Callable | None = None
_prefer_h264_sdp: Callable[[str], str] | None = None
_sdp_codec: Callable[[str], str] | None = None
_apply_bitrate: Callable | None = None
_set_bitrate: Callable | None = None
_send_meta: Callable | None = None
_send_meta_when_connected: Callable | None = None
_cancel_ice_watch: Callable | None = None
_schedule_ice_failed: Callable | None = None
_cleanup_peer_fn: Callable | None = None


def configure(
    *,
    get_relayed_track: Callable,
    maybe_upgrade_capture: Callable,
    prefer_codecs: Callable,
    prefer_h264_sdp: Callable,
    sdp_codec: Callable,
    apply_bitrate: Callable,
    set_bitrate: Callable,
    send_meta: Callable,
    send_meta_when_connected: Callable,
    cancel_ice_watch: Callable,
    schedule_ice_failed: Callable,
    cleanup_peer: Callable,
) -> None:
    global _get_relayed_track, _maybe_upgrade_capture
    global _prefer_codecs, _prefer_h264_sdp, _sdp_codec
    global _apply_bitrate, _set_bitrate, _send_meta, _send_meta_when_connected
    global _cancel_ice_watch, _schedule_ice_failed, _cleanup_peer_fn
    _get_relayed_track = get_relayed_track
    _maybe_upgrade_capture = maybe_upgrade_capture
    _prefer_codecs = prefer_codecs
    _prefer_h264_sdp = prefer_h264_sdp
    _sdp_codec = sdp_codec
    _apply_bitrate = apply_bitrate
    _set_bitrate = set_bitrate
    _send_meta = send_meta
    _send_meta_when_connected = send_meta_when_connected
    _cancel_ice_watch = cancel_ice_watch
    _schedule_ice_failed = schedule_ice_failed
    _cleanup_peer_fn = cleanup_peer


def log_active_peers(reason: str = "") -> None:
    labels = [s.label for s in sessions.values()]
    logger.info("active peers: %d %s%s", len(pcs), labels, f" ({reason})" if reason else "")


async def cleanup_stale_peers(max_age_sec: float = 120.0) -> None:
    now = time.time()
    for session in list(sessions.values()):
        if session.state in ("closed", "failed"):
            if now - session.last_activity > 5:
                await _cleanup_peer_fn(session, "stale-state")
        elif session.pc.connectionState in ("closed", "failed"):
            if now - session.last_activity > max_age_sec:
                await _cleanup_peer_fn(session, "stale-gc")


async def replace_client_session(client_id: str, new_session: PeerSession) -> None:
    old_id = client_index.get(client_id)
    if old_id and old_id in sessions and old_id != new_session.id:
        old = sessions[old_id]
        logger.info("peer %s replacing duplicate client %s", old.label, client_id[:8])
        await _cleanup_peer_fn(old, "replaced-by-client")


async def handle_offer(params: dict) -> dict:
    assert _get_relayed_track is not None

    quality = params.get("quality", DEFAULT_QUALITY)
    mobile = bool(params.get("mobile"))
    safari = bool(params.get("safari") or params.get("ios"))
    force_relay = bool(params.get("forceRelay"))
    client_id = params.get("clientId") or ""
    client_meta = params.get("clientMeta") or {}

    if mobile and quality == "balanced":
        quality = "mobile"

    preset = get_preset(quality)
    if _maybe_upgrade_capture:
        _maybe_upgrade_capture(preset)

    relay_only = host_uses_relay_only(mobile, safari, force_relay)
    offer_sdp = filter_sdp_for_peer(params["sdp"], relay_only=relay_only)
    log_sdp_candidates(client_id[:12] if client_id else "new", "remote-offer", offer_sdp)

    remote = RTCSessionDescription(sdp=offer_sdp, type=params["type"])
    pc = RTCPeerConnection(configuration=ICE_CONFIGURATION)
    session = PeerSession(
        pc=pc,
        preset=preset,
        mobile=mobile,
        safari=safari,
        relay_only=relay_only,
        client_id=client_id,
        client_meta=client_meta,
    )
    session.state = "connecting"
    session.ice_started_at = time.time()

    if client_id:
        await replace_client_session(client_id, session)

    pcs.add(pc)
    sessions[session.id] = session
    if client_id:
        client_index[client_id] = session.id

    h264_first = mobile or safari
    ice_fail_delay = 25.0 if (mobile and safari) else 15.0 if safari else 10.0

    log_peer_platform(session.label, mobile=mobile, safari=safari, client_meta=client_meta)
    logger.info(
        "peer %s created mobile=%s safari=%s relay_only=%s quality=%s",
        session.label,
        mobile,
        safari,
        relay_only,
        preset.name,
    )
    log_active_peers("new peer")

    @pc.on("connectionstatechange")
    async def on_connectionstatechange() -> None:
        state = pc.connectionState
        session.state = state
        session.last_activity = time.time()
        logger.info("peer %s connectionState=%s", session.label, state)
        if state == "connected":
            session.connected_at = time.time()
            if session.ice_started_at:
                logger.info(
                    "ice_diag peer=%s ice_duration_ms=%d",
                    session.label,
                    int((session.connected_at - session.ice_started_at) * 1000),
                )
            _cancel_ice_watch(session)
            await _apply_bitrate(session)
        elif state in ("failed", "closed"):
            _cancel_ice_watch(session)
            await _cleanup_peer_fn(session, state)

    @pc.on("iceconnectionstatechange")
    async def on_iceconnectionstatechange() -> None:
        ice = pc.iceConnectionState
        session.last_activity = time.time()
        logger.info("peer %s iceConnectionState=%s", session.label, ice)
        if ice in ("connected", "completed"):
            _cancel_ice_watch(session)
        elif ice == "failed":
            await _schedule_ice_failed(session, ice_fail_delay)

    @pc.on("datachannel")
    def on_datachannel(channel) -> None:
        if channel.label != "input":
            return
        session.input_channel = channel

        @channel.on("open")
        def on_open() -> None:
            logger.info("peer %s DataChannel open", session.label)
            asyncio.ensure_future(_send_meta_when_connected(session, channel))

        @channel.on("close")
        def on_close() -> None:
            logger.info("peer %s DataChannel closed", session.label)

        @channel.on("message")
        def on_message(message) -> None:
            if not isinstance(message, str):
                return
            session.last_activity = time.time()
            event = parse_adapt_event(message)
            if event:
                apply_peer_adaptation(
                    session,
                    event,
                    set_bitrate=_set_bitrate,
                    upgrade_capture=_maybe_upgrade_capture,
                )
                return
            handle_message(message)

    session.video_track = _get_relayed_track()
    sender = pc.addTrack(session.video_track)
    session.codec = _prefer_codecs(pc, sender, h264_first=h264_first)

    await pc.setRemoteDescription(remote)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    answer_sdp = filter_sdp_for_peer(pc.localDescription.sdp, relay_only=relay_only)
    if h264_first and _prefer_h264_sdp:
        answer_sdp = _prefer_h264_sdp(answer_sdp)
    log_sdp_candidates(session.label, "answer", answer_sdp)
    negotiated = _sdp_codec(answer_sdp)

    return {
        "sdp": answer_sdp,
        "type": pc.localDescription.type,
        "quality": preset.name,
        "peerId": session.id,
        "codec": negotiated,
        "relayOnly": relay_only,
    }


async def ice_config_handler(_: web.Request) -> web.Response:
    return web.json_response(ice_servers_json())
