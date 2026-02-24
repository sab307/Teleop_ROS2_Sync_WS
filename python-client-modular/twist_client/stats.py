"""
Statistics Tracker
==================

Tracks latency and processing duration statistics over a sliding window.
"""

from collections import deque


class Stats:
    """Sliding-window latency and processing statistics.

    Args:
        window: Number of recent samples to keep for averaging.
    """

    def __init__(self, window: int = 100):
        self._latencies: deque[float] = deque(maxlen=window)
        self._decode_us: deque[int] = deque(maxlen=window)
        self._process_us: deque[int] = deque(maxlen=window)
        self._encode_us: deque[int] = deque(maxlen=window)
        self.rx_count: int = 0
        self.ack_count: int = 0

    def record(self, latency_ms: float, decode_us: int, process_us: int, encode_us: int):
        """Record a single message's timing data.

        Args:
            latency_ms: End-to-end latency (browser send → python receive), ms.
            decode_us:  Binary decode duration, μs.
            process_us: Callback/ROS2 publish duration, μs.
            encode_us:  Ack encode duration, μs.
        """
        if latency_ms >= 0:
            self._latencies.append(latency_ms)
        self._decode_us.append(decode_us)
        self._process_us.append(process_us)
        self._encode_us.append(encode_us)
        self.rx_count += 1

    @staticmethod
    def _avg(d: deque) -> float:
        """Average of a deque, or 0.0 if empty."""
        return sum(d) / len(d) if d else 0.0

    @property
    def avg_latency_ms(self) -> float:
        return self._avg(self._latencies)

    @property
    def avg_decode_us(self) -> float:
        return self._avg(self._decode_us)

    @property
    def avg_process_us(self) -> float:
        return self._avg(self._process_us)

    @property
    def avg_encode_us(self) -> float:
        return self._avg(self._encode_us)

    def __str__(self) -> str:
        return (
            f"rx={self.rx_count} acks={self.ack_count} "
            f"lat={self.avg_latency_ms:.1f}ms "
            f"dec={self.avg_decode_us:.0f}μs "
            f"proc={self.avg_process_us:.0f}μs "
            f"enc={self.avg_encode_us:.0f}μs"
        )