"""Stream quality presets — latency-first, tunable bitrate/resolution."""

from __future__ import annotations

from dataclasses import dataclass

from PIL import Image


@dataclass(frozen=True)
class QualityPreset:
    name: str
    max_width: int
    max_height: int
    fps: int
    bitrate: int  # bits per second for VP8 encoder
    resample: Image.Resampling


PRESETS: dict[str, QualityPreset] = {
    "low": QualityPreset(
        name="low",
        max_width=854,
        max_height=480,
        fps=12,
        bitrate=900_000,
        resample=Image.Resampling.BILINEAR,
    ),
    "balanced": QualityPreset(
        name="balanced",
        max_width=960,
        max_height=540,
        fps=12,
        bitrate=1_800_000,
        resample=Image.Resampling.BILINEAR,
    ),
    "high": QualityPreset(
        name="high",
        max_width=1280,
        max_height=720,
        fps=15,
        bitrate=3_000_000,
        resample=Image.Resampling.LANCZOS,
    ),
}

DEFAULT_QUALITY = "balanced"


def get_preset(name: str) -> QualityPreset:
    return PRESETS.get(name, PRESETS[DEFAULT_QUALITY])
