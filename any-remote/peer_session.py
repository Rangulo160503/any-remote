"""One WebRTC peer session — isolated PC, DataChannel, and video relay proxy."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from aiortc import RTCPeerConnection
from aiortc.contrib.media import MediaStreamTrack

from stream_config import QualityPreset


@dataclass
class PeerSession:
    """Isolated state for a single browser viewer."""

    pc: RTCPeerConnection
    preset: QualityPreset
    mobile: bool
    safari: bool = False
    relay_only: bool = False
    client_id: str = ""
    client_meta: dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    video_track: MediaStreamTrack | None = None
    input_channel: object | None = None
    codec: str = "video/VP8"
    state: str = "new"
    adaptive_mode: str | None = None
    target_bitrate: int | None = None
    target_fps: int | None = None
    last_packet_loss: float | None = None
    last_rtt_ms: float | None = None
    created_at: float = field(default_factory=time.time)
    last_activity: float = field(default_factory=time.time)
    ice_started_at: float | None = None
    connected_at: float | None = None
    _ice_watch_task: object | None = field(default=None, repr=False)

    @property
    def label(self) -> str:
        if self.safari:
            kind = "safari"
        elif self.mobile:
            kind = "mobile"
        else:
            kind = "desktop"
        return f"{self.id} ({kind})"
