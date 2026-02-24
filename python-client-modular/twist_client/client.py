"""
WebSocket Twist Client
======================

Connects to the relay server over WebSocket, receives binary Twist
commands, sends acknowledgments with full latency chain, and maintains
NTP-style clock synchronization.
"""

import asyncio
import json
import logging
from typing import Optional, Callable

import aiohttp

from .twist_protocol import (
    TwistWithLatency,
    TwistAck,
    LatencyTimestamps,
    ClockSyncRequest,
    ClockSyncResponse,
    MessageType,
    current_time_ms,
    perf_counter_us,
)
from .clock_sync import ClockSync
from .stats import Stats
from .ros2_publisher import ROS2Publisher

logger = logging.getLogger(__name__)


class TwistClient:
    """WebSocket client for binary Twist messages.

    Handles:
      - Receiving variable-size Twist commands from the relay
      - Sending fixed-size TwistAck with full timestamp chain
      - NTP-style clock synchronization with the relay
      - Optional ROS2 publishing and user callbacks

    Args:
        url:        WebSocket URL of the relay server.
        on_twist:   Optional callback invoked for each decoded Twist message.
        ros2_topic: If set, publish decoded Twist to this ROS2 topic.
    """

    def __init__(
        self,
        url: str,
        on_twist: Optional[Callable[[TwistWithLatency], None]] = None,
        ros2_topic: Optional[str] = None,
    ):
        self.url = f"{url}?type=python" if "?" not in url else f"{url}&type=python"
        self.on_twist = on_twist

        self._session: Optional[aiohttp.ClientSession] = None
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._connected = False

        self._clock = ClockSync()
        self.stats = Stats()

        self._ros2 = ROS2Publisher(ros2_topic) if ros2_topic else None
        self._tasks: list[asyncio.Task] = []

    # ---- Properties ----------------------------------------------------------

    @property
    def connected(self) -> bool:
        return self._connected and self._ws is not None

    @property
    def clock_offset(self) -> float:
        """Current clock offset to relay (ms). Positive = relay ahead."""
        return self._clock.offset

    @property
    def clock_synced(self) -> bool:
        """True if clock is synchronized (≥3 samples)."""
        return self._clock.synced

    def to_relay_time(self, local_time_ms: int) -> int:
        """Convert local timestamp to relay time using clock offset."""
        return self._clock.to_relay_time(local_time_ms)

    # ---- Connection lifecycle ------------------------------------------------

    async def connect(self) -> bool:
        """Connect to the relay server and start background tasks.

        Returns:
            True if connection succeeded.
        """
        try:
            self._session = aiohttp.ClientSession()
            self._ws = await self._session.ws_connect(self.url, heartbeat=25.0)

            # Wait for welcome message
            msg = await asyncio.wait_for(self._ws.receive(), timeout=5.0)
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = json.loads(msg.data)
                if data.get("type") == "welcome":
                    logger.info(f"Connected: {data.get('peer_id')}")

            self._connected = True

            if self._ros2:
                self._ros2.init()

            # Start background tasks
            self._tasks.append(asyncio.create_task(self._recv_loop()))
            self._tasks.append(asyncio.create_task(self._sync_loop()))

            await self._send_sync()
            return True

        except Exception as e:
            logger.error(f"Connect failed: {e}")
            await self._cleanup()
            return False

    async def close(self):
        """Gracefully shut down the client."""
        logger.info("Closing...")
        self._connected = False
        await self._cleanup()

    # ---- Receive loop --------------------------------------------------------

    async def _recv_loop(self):
        """Main receive loop — dispatches binary messages by type."""
        try:
            async for msg in self._ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    await self._handle_binary(msg.data)
                elif msg.type == aiohttp.WSMsgType.TEXT:
                    pass  # Ignore JSON messages
                elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED):
                    break
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Recv error: {e}")
        self._connected = False

    async def _handle_binary(self, data: bytes):
        """Route a binary message to the appropriate handler."""
        if len(data) < 1:
            return

        msg_type = data[0]
        rx_time = current_time_ms()

        if msg_type == MessageType.TWIST:
            await self._handle_twist(data, rx_time)
        elif msg_type == MessageType.CLOCK_SYNC_RESPONSE:
            self._handle_sync_response(data)

    # ---- Twist handling ------------------------------------------------------

    async def _handle_twist(self, data: bytes, rx_time: int):
        """Decode a Twist message, run callbacks, and send an ack."""
        # Decode
        decode_start = perf_counter_us()
        try:
            twist = TwistWithLatency.decode(data)
        except Exception as e:
            logger.error(f"Decode error: {e} (size={len(data)})")
            return
        decode_us = perf_counter_us() - decode_start

        # Store LOCAL timestamps (converted to relay time in ack)
        twist.timestamps.t3_python_rx = rx_time
        twist.timestamps.python_decode_us = decode_us

        # Process — user callback + optional ROS2 publish
        process_start = perf_counter_us()
        if self.on_twist:
            try:
                self.on_twist(twist)
            except Exception as e:
                logger.error(f"Callback error: {e}")
        if self._ros2:
            self._ros2.publish(twist)
        process_us = perf_counter_us() - process_start
        twist.timestamps.python_process_us = process_us

        # Send ack (converts to relay time inside)
        await self._send_ack(twist)

        # Stats (using local time for internal tracking)
        latency = rx_time - twist.timestamps.t1_browser_send
        self.stats.record(latency, decode_us, process_us, twist.timestamps.python_encode_us)

        logger.debug(
            f"Twist #{twist.message_id}: lat={latency}ms offset={self._clock.offset:.1f}ms"
        )

    async def _send_ack(self, twist: TwistWithLatency):
        """Build and send a TwistAck with timestamps converted to relay time."""
        if not self.connected:
            return

        encode_start = perf_counter_us()
        local_ack_time = current_time_ms()

        # Convert Python timestamps to RELAY time for accurate cross-clock comparison
        # offset = relay_time - python_time, so relay_time = python_time + offset
        offset = self._clock.offset

        ts = LatencyTimestamps(
            t1_browser_send=twist.timestamps.t1_browser_send,
            t2_relay_rx=twist.timestamps.t2_relay_rx,
            t3_relay_tx=twist.timestamps.t3_relay_tx,
            t3_python_rx=int(twist.timestamps.t3_python_rx + offset),
            t4_python_ack=int(local_ack_time + offset),
            python_decode_us=twist.timestamps.python_decode_us,
            python_process_us=twist.timestamps.python_process_us,
            python_encode_us=0,  # Will update after encode
        )

        ack = TwistAck(message_id=twist.message_id, timestamps=ts)
        _ = ack.encode()  # First encode to measure time
        encode_us = perf_counter_us() - encode_start

        # Update encode time and re-encode
        ts.python_encode_us = encode_us
        twist.timestamps.python_encode_us = encode_us  # For stats
        ack = TwistAck(message_id=twist.message_id, timestamps=ts)
        data = ack.encode()

        try:
            await self._ws.send_bytes(data)
            self.stats.ack_count += 1
        except Exception as e:
            logger.error(f"Send ack error: {e}")

    # ---- Clock sync ----------------------------------------------------------

    async def _sync_loop(self):
        """Periodic clock sync with the relay server."""
        try:
            # Rapid initial sync (3 samples for median)
            await self._send_sync()
            await asyncio.sleep(0.5)
            await self._send_sync()
            await asyncio.sleep(0.5)
            await self._send_sync()

            # Then periodic maintenance
            while self.connected:
                await asyncio.sleep(10.0)
                await self._send_sync()
        except asyncio.CancelledError:
            pass

    async def _send_sync(self):
        """Send a single clock sync request."""
        if not self.connected:
            return
        req = ClockSyncRequest(t1=current_time_ms())
        try:
            await self._ws.send_bytes(req.encode())
        except Exception as e:
            logger.error(f"Sync send error: {e}")

    def _handle_sync_response(self, data: bytes):
        """Process a clock sync response from the relay."""
        t4 = current_time_ms()
        try:
            resp = ClockSyncResponse.decode(data)
            offset, rtt = self._clock.process(resp.t1, resp.t2, resp.t3, t4)
            sync_status = "synced" if self._clock.synced else f"{self._clock.sample_count}/3"
            logger.info(f"Clock sync: offset={offset:.1f}ms rtt={rtt:.1f}ms ({sync_status})")
        except Exception as e:
            logger.error(f"Sync decode error: {e}")

    # ---- Cleanup -------------------------------------------------------------

    async def _cleanup(self):
        """Cancel tasks and close connections."""
        for task in self._tasks:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        if self._ws and not self._ws.closed:
            await self._ws.close()
        if self._session:
            await self._session.close()
        if self._ros2:
            self._ros2.shutdown()