"""Stream quality presets — latency-first with tunable sharpness."""

from __future__ import annotations

from dataclasses import dataclass

from PIL import Image


@dataclass(frozen=True)
class QualityPreset:
    name: str
    max_width: int
    max_height: int
    fps: int
    bitrate: int
    resample: Image.Resampling


PRESETS: dict[str, QualityPreset] = {
    "mobile": QualityPreset(
        name="mobile",
        max_width=640,
        max_height=360,
        fps=10,
        bitrate=700_000,
        resample=Image.Resampling.BILINEAR,
    ),
    "low": QualityPreset(
        name="low",
        max_width=854,
        max_height=480,
        fps=12,
        bitrate=1_200_000,
        resample=Image.Resampling.BILINEAR,
    ),
    "balanced": QualityPreset(
        name="balanced",
        max_width=960,
        max_height=540,
        fps=12,
        bitrate=2_500_000,
        resample=Image.Resampling.LANCZOS,
    ),
    "high": QualityPreset(
        name="high",
        max_width=1280,
        max_height=720,
        fps=15,
        bitrate=4_000_000,
        resample=Image.Resampling.LANCZOS,
    ),
    "ultra": QualityPreset(
        name="ultra",
        max_width=1920,
        max_height=1080,
        fps=15,
        bitrate=6_000_000,
        resample=Image.Resampling.LANCZOS,
    ),
}

DEFAULT_QUALITY = "balanced"

ORDER = ("mobile", "low", "balanced", "high", "ultra")


def get_preset(name: str) -> QualityPreset:
    return PRESETS.get(name, PRESETS[DEFAULT_QUALITY])


def max_preset(a: QualityPreset, b: QualityPreset) -> QualityPreset:
    """Return preset with larger capture area (for shared capture upgrade)."""
    if a.max_width * a.max_height >= b.max_width * b.max_height:
        return a
    return b
