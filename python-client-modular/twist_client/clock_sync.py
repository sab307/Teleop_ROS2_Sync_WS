"""
Clock Synchronization
=====================

NTP-style clock sync between the Python client and the relay server.
Uses median filtering over multiple samples for robust offset estimation.

Offset convention:
    offset = relay_time - local_time
    relay_time = local_time + offset
"""

import logging

logger = logging.getLogger(__name__)


class ClockSync:
    """NTP-style clock synchronization with median filtering.

    Collects round-trip samples between this client and the relay server,
    then computes a median offset to convert local timestamps to relay time.

    Args:
        samples: Maximum number of samples to keep for median calculation.
    """

    def __init__(self, samples: int = 10):
        self._offsets: list[float] = []
        self._rtts: list[float] = []
        self._max_samples = samples
        self.offset: float = 0.0
        self.rtt: float = 0.0

    def process(self, t1: int, t2: int, t3: int, t4: int) -> tuple[float, float]:
        """Process a clock sync round-trip and update offset estimate.

        Args:
            t1: Client send time (local clock, ms).
            t2: Server receive time (relay clock, ms).
            t3: Server send time (relay clock, ms).
            t4: Client receive time (local clock, ms).

        Returns:
            Tuple of (median_offset_ms, this_sample_rtt_ms).
        """
        rtt = (t4 - t1) - (t3 - t2)
        offset = ((t2 - t1) + (t3 - t4)) / 2

        self._offsets.append(offset)
        self._rtts.append(rtt)

        if len(self._offsets) > self._max_samples:
            self._offsets.pop(0)
            self._rtts.pop(0)

        # Use median for robustness against outliers
        self.offset = sorted(self._offsets)[len(self._offsets) // 2]
        self.rtt = sorted(self._rtts)[len(self._rtts) // 2]

        return self.offset, rtt

    @property
    def synced(self) -> bool:
        """True if enough samples have been collected (≥3)."""
        return len(self._offsets) >= 3

    @property
    def sample_count(self) -> int:
        """Number of samples collected so far."""
        return len(self._offsets)

    def to_relay_time(self, local_time_ms: int) -> int:
        """Convert a local timestamp to relay time.

        Args:
            local_time_ms: Timestamp in local clock (ms).

        Returns:
            Estimated relay-clock timestamp (ms).
        """
        return int(local_time_ms + self.offset)