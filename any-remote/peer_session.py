"""One WebRTC peer session — isolated PC, DataChannel, and video relay proxy."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaStreamTrack

from stream_config import QualityPreset, get_preset

if TYPE_CHECKING:
    from screen_track import ScreenCapture

logger = logging.getLogger("peer")


@dataclass
class PeerSession:
    """Isolated state for a single browser viewer."""

    pc: RTCPeerConnection
    preset: QualityPreset
    mobile: bool
    safari: bool = False
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    video_track: MediaStreamTrack | None = None
    codec: str = "video/VP8"
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
