#!/usr/bin/env python3
"""
WebSocket Twist Client - Binary Protocol
=========================================

Receives binary Twist commands and sends binary acknowledgments
with timing data for end-to-end latency measurement.

Usage:
    python main.py [--url ws://localhost:8080/ws/data] [--topic /cmd_vel]
"""

import asyncio
import argparse
import logging
import signal
import sys
from collections import deque
from dataclasses import dataclass
from typing import Optional, Callable

import aiohttp

from twist_protocol import (
    TwistWithLatency, TwistAck, LatencyTimestamps,
    ClockSyncRequest, ClockSyncResponse,
    MessageType, current_time_ms, perf_counter_us,
)

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("TwistClient")


# =============================================================================
# Optional ROS2 Integration
# =============================================================================

ROS2_AVAILABLE = False
try:
    import rclpy
    from rclpy.node import Node
    from geometry_msgs.msg import Twist
    ROS2_AVAILABLE = True
    logger.info("ROS2 available")
except ImportError:
    logger.info("ROS2 not available")


class ROS2Publisher:
    """Optional ROS2 Twist publisher."""
    
    def __init__(self, topic: str):
        self.topic = topic
        self._node = None
        self._pub = None
        self._ok = False
        
    def init(self) -> bool:
        if not ROS2_AVAILABLE:
            return False
        try:
            if not rclpy.ok():
                rclpy.init()
            self._node = rclpy.create_node('twist_bridge')
            self._pub = self._node.create_publisher(Twist, self.topic, 10)
            self._ok = True
            logger.info(f"ROS2 publisher: {self.topic}")
            return True
        except Exception as e:
            logger.error(f"ROS2 init failed: {e}")
            return False
    
    def publish(self, twist: TwistWithLatency):
        if not self._ok:
            return
        msg = Twist()
        msg.linear.x = twist.linear_x
        msg.linear.y = twist.linear_y
        msg.linear.z = twist.linear_z
        msg.angular.x = twist.angular_x
        msg.angular.y = twist.angular_y
        msg.angular.z = twist.angular_z
        self._pub.publish(msg)
    
    def shutdown(self):
        if self._node:
            self._node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


# =============================================================================
# Statistics
# =============================================================================

@dataclass
class Stats:
    """Latency statistics tracker."""
    
    def __init__(self, window: int = 100):
        self._latencies = deque(maxlen=window)
        self._decode_us = deque(maxlen=window)
        self._process_us = deque(maxlen=window)
        self._encode_us = deque(maxlen=window)
        self.rx_count = 0
        self.ack_count = 0
    
    def record(self, latency_ms: float, decode_us: int, process_us: int, encode_us: int):
        if latency_ms >= 0:
            self._latencies.append(latency_ms)
        self._decode_us.append(decode_us)
        self._process_us.append(process_us)
        self._encode_us.append(encode_us)
        self.rx_count += 1
    
    def avg(self, d: deque) -> float:
        return sum(d) / len(d) if d else 0
    
    def __str__(self) -> str:
        return (f"rx={self.rx_count} acks={self.ack_count} "
                f"lat={self.avg(self._latencies):.1f}ms "
                f"dec={self.avg(self._decode_us):.0f}μs "
                f"proc={self.avg(self._process_us):.0f}μs "
                f"enc={self.avg(self._encode_us):.0f}μs")


# =============================================================================
# Clock Synchronization
# =============================================================================

class ClockSync:
    """NTP-style clock sync."""
    
    def __init__(self, samples: int = 10):
        self._offsets = []
        self._rtts = []
        self._max = samples
        self.offset = 0.0
        self.rtt = 0.0
    
    def process(self, t1: int, t2: int, t3: int, t4: int) -> tuple:
        rtt = (t4 - t1) - (t3 - t2)
        offset = ((t2 - t1) + (t3 - t4)) / 2
        
        self._offsets.append(offset)
        self._rtts.append(rtt)
        
        if len(self._offsets) > self._max:
            self._offsets.pop(0)
            self._rtts.pop(0)
        
        # Use median
        self.offset = sorted(self._offsets)[len(self._offsets) // 2]
        self.rtt = sorted(self._rtts)[len(self._rtts) // 2]
        
        return self.offset, rtt
    
    @property
    def synced(self) -> bool:
        return len(self._offsets) >= 3


# =============================================================================
# WebSocket Client
# =============================================================================

class TwistClient:
    """WebSocket client for binary Twist messages."""
    
    def __init__(self, url: str, on_twist: Optional[Callable] = None, ros2_topic: Optional[str] = None):
        self.url = f"{url}?type=python" if "?" not in url else f"{url}&type=python"
        self.on_twist = on_twist
        
        self._session: Optional[aiohttp.ClientSession] = None
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._connected = False
        
        self._clock = ClockSync()
        self.stats = Stats()
        
        self._ros2 = ROS2Publisher(ros2_topic) if ros2_topic else None
        self._tasks = []
    
    @property
    def connected(self) -> bool:
        return self._connected and self._ws is not None
    
    async def connect(self) -> bool:
        try:
            self._session = aiohttp.ClientSession()
            self._ws = await self._session.ws_connect(self.url, heartbeat=25.0)
            
            # Wait for welcome
            msg = await asyncio.wait_for(self._ws.receive(), timeout=5.0)
            if msg.type == aiohttp.WSMsgType.TEXT:
                import json
                data = json.loads(msg.data)
                if data.get("type") == "welcome":
                    logger.info(f"Connected: {data.get('peer_id')}")
            
            self._connected = True
            
            if self._ros2:
                self._ros2.init()
            
            # Start tasks
            self._tasks.append(asyncio.create_task(self._recv_loop()))
            self._tasks.append(asyncio.create_task(self._sync_loop()))
            
            await self._send_sync()
            return True
            
        except Exception as e:
            logger.error(f"Connect failed: {e}")
            await self._cleanup()
            return False
    
    async def _recv_loop(self):
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
        if len(data) < 1:
            return
        
        msg_type = data[0]
        rx_time = current_time_ms()
        
        if msg_type == MessageType.TWIST:
            await self._handle_twist(data, rx_time)
        elif msg_type == MessageType.CLOCK_SYNC_RESPONSE:
            self._handle_sync_response(data)
    
    async def _handle_twist(self, data: bytes, rx_time: int):
        # Decode
        decode_start = perf_counter_us()
        try:
            twist = TwistWithLatency.decode(data)
        except Exception as e:
            logger.error(f"Decode error: {e} (size={len(data)})")
            return
        decode_us = perf_counter_us() - decode_start
        
        # Store LOCAL timestamps (will convert to relay time in ack)
        twist.timestamps.t3_python_rx = rx_time
        twist.timestamps.python_decode_us = decode_us
        
        # Process
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
        
        logger.debug(f"Twist #{twist.message_id}: lat={latency}ms offset={self._clock.offset:.1f}ms")
    
    async def _send_ack(self, twist: TwistWithLatency):
        if not self.connected:
            return
        
        encode_start = perf_counter_us()
        local_ack_time = current_time_ms()
        
        # Convert Python timestamps to RELAY time for accurate cross-clock comparison
        # offset = relay_time - python_time, so relay_time = python_time + offset
        offset = self._clock.offset
        
        # Create timestamps with converted times
        ts = LatencyTimestamps(
            t1_browser_send=twist.timestamps.t1_browser_send,  # Already in browser time (relay will have adjusted if needed)
            t2_relay_rx=twist.timestamps.t2_relay_rx,          # Already in relay time
            t3_relay_tx=twist.timestamps.t3_relay_tx,          # Already in relay time
            t3_python_rx=int(twist.timestamps.t3_python_rx + offset),  # Convert to relay time
            t4_python_ack=int(local_ack_time + offset),                # Convert to relay time
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
    
    def _handle_sync_response(self, data: bytes):
        t4 = current_time_ms()
        try:
            resp = ClockSyncResponse.decode(data)
            offset, rtt = self._clock.process(resp.t1, resp.t2, resp.t3, t4)
            sync_status = "synced" if self._clock.synced else f"{len(self._clock._offsets)}/3"
            logger.info(f"Clock sync: offset={offset:.1f}ms rtt={rtt:.1f}ms ({sync_status})")
        except Exception as e:
            logger.error(f"Sync decode error: {e}")
    
    async def _sync_loop(self):
        """Periodic clock sync with relay."""
        try:
            # Immediate sync on connect
            await self._send_sync()
            await asyncio.sleep(0.5)  # Wait for response
            await self._send_sync()   # Second sample
            await asyncio.sleep(0.5)
            await self._send_sync()   # Third sample for median
            
            # Then periodic sync
            while self.connected:
                await asyncio.sleep(10.0)
                await self._send_sync()
        except asyncio.CancelledError:
            pass
    
    async def _send_sync(self):
        if not self.connected:
            return
        req = ClockSyncRequest(t1=current_time_ms())
        try:
            await self._ws.send_bytes(req.encode())
        except Exception as e:
            logger.error(f"Sync send error: {e}")
    
    def to_relay_time(self, local_time_ms: int) -> int:
        """Convert local timestamp to relay time using clock offset."""
        # offset = relay_time - local_time, so relay_time = local_time + offset
        return int(local_time_ms + self._clock.offset)
    
    @property
    def clock_offset(self) -> float:
        """Current clock offset to relay (ms). Positive = relay ahead."""
        return self._clock.offset
    
    @property
    def clock_synced(self) -> bool:
        """True if clock is synchronized (≥3 samples)."""
        return self._clock.synced
    
    async def _cleanup(self):
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
    
    async def close(self):
        logger.info("Closing...")
        self._connected = False
        await self._cleanup()


# =============================================================================
# Main
# =============================================================================

def parse_args():
    parser = argparse.ArgumentParser(description="Twist Client - Binary Protocol")
    parser.add_argument("--url", "-u", default="ws://localhost:8080/ws/data")
    parser.add_argument("--topic", "-t", default=None, help="ROS2 topic")
    parser.add_argument("--verbose", "-v", action="store_true")
    return parser.parse_args()


async def main():
    args = parse_args()
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    
    print(f"URL:   {args.url}")
    print(f"Topic: {args.topic or 'disabled'}\n")
    
    client = TwistClient(url=args.url, ros2_topic=args.topic)
    
    shutdown = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, shutdown.set)
    
    try:
        if await client.connect():
            print("Connected. Waiting for commands...\n")
            
            async def stats_printer():
                while not shutdown.is_set():
                    await asyncio.sleep(5.0)
                    logger.info(f"Stats: {client.stats}")
            
            task = asyncio.create_task(stats_printer())
            await shutdown.wait()
            task.cancel()
        else:
            print("Connection failed")
            return 1
    finally:
        await client.close()
    
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)