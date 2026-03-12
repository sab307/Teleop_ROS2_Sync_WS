#!/usr/bin/env python3
"""
WebRTC Twist Client (P2P)
=========================

Connects to the Go signaling server via WebSocket, negotiates a WebRTC
DataChannel with the browser, then handles binary robot-control messages
(Twist commands, acknowledgments, clock sync) peer-to-peer.

The Go server is ONLY used for the initial WebRTC handshake (SDP + ICE).
Once the RTCDataChannel opens, all data flows directly to the browser.

Architecture:
  Python ←──WS(signaling)──→ Go ←──WS(signaling)──→ Browser
  Python ←──────────── RTCDataChannel (P2P) ────────────────→ Browser

Binary Protocol (over DataChannel, all messages include trailing CRC-8/SMBUS byte):
  0x01  Twist          Browser → Python (19 + 8×N bytes)
  0x02  P2P Ack        Python → Browser (46 bytes)
  0x03  ClockSyncReq   Browser → Python (10 bytes)
  0x04  ClockSyncResp  Python → Browser (26 bytes)

Usage:
    python main.py [--signal ws://localhost:8080/ws/signal] [--topic /cmd_vel]

Dependencies:
    pip install aiortc aiohttp
"""

import asyncio
import argparse
import csv
import json
import logging
import os
import signal
import sys
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Callable

import aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceCandidate
from aiortc.contrib.signaling import object_from_string

from twist_protocol import (
    TwistWithLatency, TwistAck, LatencyTimestamps,
    ClockSyncRequest, ClockSyncResponse,
    MessageType, current_time_ms, perf_counter_us,
    P2P_TWIST_ACK_SIZE,
)

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("WebRTC-TwistClient")


# ─── Optional ROS2 ────────────────────────────────────────────────────────────

ROS2_AVAILABLE = False
try:
    import rclpy
    from rclpy.node import Node
    from geometry_msgs.msg import Twist
    ROS2_AVAILABLE = True
    logger.info("ROS2 available")
except ImportError:
    logger.info("ROS2 not available (running without robot)")


class ROS2Publisher:
    """Publishes Twist to a ROS2 topic."""

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


# ─── Stats ────────────────────────────────────────────────────────────────────

@dataclass
class Stats:
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
        return sum(d) / len(d) if d else 0.0

    def __str__(self) -> str:
        return (
            f"rx={self.rx_count} acks={self.ack_count} "
            f"lat={self.avg(self._latencies):.1f}ms "
            f"dec={self.avg(self._decode_us):.0f}μs "
            f"proc={self.avg(self._process_us):.0f}μs "
            f"enc={self.avg(self._encode_us):.0f}μs"
        )


# ─── Timestamp File Logger ────────────────────────────────────────────────────

class TimestampFileLogger:
    """Writes every Twist and ClockSync event to a CSV log file.

    Twist rows (type="TWIST"):
        time_iso          UTC wall-clock when the ack was sent (ISO-8601)
        seq               Running counter shared across TWIST + SYNC rows
        msg_id            Browser message ID
        t1_browser_ms     Browser send timestamp  (ms, browser epoch)
        t3_python_rx_ms   Python receive timestamp (ms, Python epoch)
        t4_python_ack_ms  Python ack timestamp     (ms, Python epoch)
        approx_lat_ms     t3 - t1  (raw, no clock correction — trend indicator)
        decode_us / process_us / encode_us   Per-stage Python durations (μs)
        total_python_us   decode + process + encode
        linear_x/y/z      Velocity fields
        angular_x/y/z     Velocity fields

    ClockSync rows (type="SYNC"):
        time_iso
        seq
        t1_browser_ms     Browser send time (echoed back)
        t2_python_rx_ms   Python receive time
        t3_python_tx_ms   Python transmit time
        sync_proc_us      (t3 - t2) in μs
    """

    ALL_FIELDS = [
        'time_iso', 'type', 'seq', 'msg_id',
        't1_browser_ms', 't3_python_rx_ms', 't4_python_ack_ms',
        'approx_lat_ms',
        'decode_us', 'process_us', 'encode_us', 'total_python_us',
        'linear_x', 'linear_y', 'linear_z',
        'angular_x', 'angular_y', 'angular_z',
        # SYNC-only columns (empty for TWIST rows)
        't2_python_rx_ms', 't3_python_tx_ms', 'sync_proc_us',
    ]

    def __init__(self, path: str):
        self._path   = path
        self._seq    = 0
        self._fh     = None
        self._writer = None

    def open(self):
        """Open (or append to) the CSV file; write column header if new."""
        new_file = not os.path.exists(self._path) or os.path.getsize(self._path) == 0
        self._fh = open(self._path, 'a', newline='', encoding='utf-8')
        self._writer = csv.DictWriter(
            self._fh, fieldnames=self.ALL_FIELDS, extrasaction='ignore',
        )
        if new_file:
            self._writer.writeheader()
            self._fh.flush()
        logger.info(f"Timestamp log → {os.path.abspath(self._path)}")

    def close(self):
        if self._fh:
            self._fh.flush()
            self._fh.close()
            self._fh = None

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat(timespec='milliseconds')

    def log_twist(self, twist) -> None:
        """Append one TWIST row (called after encode_us is populated)."""
        if self._writer is None:
            return
        self._seq += 1
        ts       = twist.timestamps
        total_us = ts.python_decode_us + ts.python_process_us + ts.python_encode_us
        self._writer.writerow({
            'time_iso':         self._now_iso(),
            'type':             'TWIST',
            'seq':              self._seq,
            'msg_id':           twist.message_id,
            't1_browser_ms':    ts.t1_browser_send,
            't3_python_rx_ms':  ts.t3_python_rx,
            't4_python_ack_ms': ts.t4_python_ack,
            'approx_lat_ms':    ts.t3_python_rx - ts.t1_browser_send,
            'decode_us':        ts.python_decode_us,
            'process_us':       ts.python_process_us,
            'encode_us':        ts.python_encode_us,
            'total_python_us':  total_us,
            'linear_x':         round(twist.linear_x,  6),
            'linear_y':         round(twist.linear_y,  6),
            'linear_z':         round(twist.linear_z,  6),
            'angular_x':        round(twist.angular_x, 6),
            'angular_y':        round(twist.angular_y, 6),
            'angular_z':        round(twist.angular_z, 6),
        })
        self._fh.flush()

    def log_sync(self, t1: int, t2: int, t3: int) -> None:
        """Append one SYNC row."""
        if self._writer is None:
            return
        self._seq += 1
        self._writer.writerow({
            'time_iso':         self._now_iso(),
            'type':             'SYNC',
            'seq':              self._seq,
            't1_browser_ms':    t1,
            't2_python_rx_ms':  t2,
            't3_python_tx_ms':  t3,
            'sync_proc_us':     (t3 - t2) * 1000,   # ms → μs
        })
        self._fh.flush()


# ─── P2P Twist Client ─────────────────────────────────────────────────────────

class P2PTwistClient:
    """
    Manages the full lifecycle:
      1. WebSocket signaling with Go
      2. WebRTC handshake (receive offer, send answer, ICE)
      3. DataChannel operation (Twist, Ack, ClockSync)
    """

    def __init__(
        self,
        signal_url: str,
        on_twist: Optional[Callable] = None,
        ros2_topic: Optional[str] = None,
        ts_logger: Optional['TimestampFileLogger'] = None,
    ):
        # Ensure URL has ?role=python
        if "?" in signal_url:
            self._signal_url = f"{signal_url}&role=python"
        else:
            self._signal_url = f"{signal_url}?role=python"

        self.on_twist  = on_twist
        self.stats     = Stats()
        self._ts_log   = ts_logger   # TimestampFileLogger (may be None)

        # WebSocket signaling state
        self._session: Optional[aiohttp.ClientSession] = None
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None

        # WebRTC state (one RTCPeerConnection per browser session)
        # We support one active peer at a time for simplicity
        self._pc: Optional[RTCPeerConnection] = None
        self._dc = None           # RTCDataChannel (set by browser)
        self._browser_id: str = ""  # ID of the browser we are paired with

        # ROS2
        self._ros2 = ROS2Publisher(ros2_topic) if ros2_topic else None

        # Shutdown event
        self._shutdown = asyncio.Event()

    # ── Connection ───────────────────────────────────────────────────────────

    async def run(self):
        """Connect to signaling server and wait for WebRTC sessions."""
        logger.info(f"Connecting to signaling: {self._signal_url}")

        if self._ros2:
            self._ros2.init()

        while not self._shutdown.is_set():
            try:
                await self._signaling_loop()
            except Exception as e:
                logger.error(f"Signaling error: {e}")
                await asyncio.sleep(3)
                logger.info("Reconnecting to signaling server...")

        await self._cleanup()

    async def _signaling_loop(self):
        """Connect to Go signaling WS and process messages until disconnect."""
        self._session = aiohttp.ClientSession()
        try:
            self._ws = await self._session.ws_connect(
                self._signal_url, heartbeat=25.0
            )
            logger.info("Signaling connected. Waiting for browser...")

            async for msg in self._ws:
                if self._shutdown.is_set():
                    break
                if msg.type == aiohttp.WSMsgType.TEXT:
                    await self._handle_signal(json.loads(msg.data))
                elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED):
                    logger.info("Signaling disconnected")
                    break
        finally:
            if self._ws and not self._ws.closed:
                await self._ws.close()
            await self._session.close()
            self._session = None
            self._ws = None

    # ── Signaling ────────────────────────────────────────────────────────────

    async def _handle_signal(self, msg: dict):
        msg_type = msg.get("type")

        if msg_type == "welcome":
            logger.info(f"Signaling welcome: my_id={msg.get('peer_id')}")

        elif msg_type == "peer_ready":
            role = msg.get("role")
            browser_id = msg.get("from_peer", "")
            logger.info(f"Peer ready: role={role} browser={browser_id}")
            # A new browser has connected and is ready to start P2P.
            # We close any existing PC before creating a new one.
            if self._pc is not None:
                await self._close_pc()
            self._browser_id = browser_id
            self._pc = RTCPeerConnection()
            self._setup_pc_callbacks(browser_id)

        elif msg_type == "offer":
            browser_id = msg.get("from_peer", "")
            sdp_str = msg.get("sdp", "")
            logger.info(f"Received offer from browser {browser_id}")

            if self._pc is None:
                # Peer-ready might not have arrived first; create PC now
                self._browser_id = browser_id
                self._pc = RTCPeerConnection()
                self._setup_pc_callbacks(browser_id)

            offer = RTCSessionDescription(sdp=sdp_str, type="offer")
            await self._pc.setRemoteDescription(offer)

            answer = await self._pc.createAnswer()
            await self._pc.setLocalDescription(answer)

            # Send answer back via signaling (include to_peer so Go can route it)
            await self._send_signal({
                "type": "answer",
                "sdp": self._pc.localDescription.sdp,
                "to_peer": browser_id,
            })
            logger.info(f"Sent answer to browser {browser_id}")

        elif msg_type == "ice_candidate":
            if self._pc is None:
                return
            candidate_str = msg.get("candidate", "")
            sdp_mid = msg.get("sdpMid", "")
            sdp_mline = msg.get("sdpMLineIndex", 0)
            if candidate_str:
                try:
                    candidate = RTCIceCandidate(
                        component=1,
                        foundation="",
                        ip="",
                        port=0,
                        priority=0,
                        protocol="",
                        type="",
                        sdpMid=sdp_mid,
                        sdpMLineIndex=sdp_mline,
                    )
                    # aiortc parses the candidate string from sdp attr format
                    # We reconstruct via the raw string approach
                    from aiortc.sdp import candidate_from_sdp
                    candidate = candidate_from_sdp(candidate_str.replace("candidate:", ""))
                    candidate.sdpMid = sdp_mid
                    candidate.sdpMLineIndex = sdp_mline
                    await self._pc.addIceCandidate(candidate)
                except Exception as e:
                    logger.debug(f"ICE candidate parse error (may be ok): {e}")

        elif msg_type == "peer_disconnected":
            logger.info(f"Browser disconnected: {msg.get('from_peer', '')}")
            if self._pc is not None:
                await self._close_pc()

    def _setup_pc_callbacks(self, browser_id: str):
        """Attach event handlers to a freshly created RTCPeerConnection."""
        pc = self._pc

        @pc.on("icecandidate")
        async def on_icecandidate(candidate):
            if candidate is None:
                return
            try:
                from aiortc.sdp import candidate_to_sdp
                cand_str = candidate_to_sdp(candidate)
                await self._send_signal({
                    "type": "ice_candidate",
                    "candidate": f"candidate:{cand_str}",
                    "sdpMid": candidate.sdpMid or "0",
                    "sdpMLineIndex": candidate.sdpMLineIndex or 0,
                    "to_peer": browser_id,
                })
            except Exception as e:
                logger.debug(f"ICE send error: {e}")

        @pc.on("datachannel")
        def on_datachannel(channel):
            logger.info(f"DataChannel opened: label={channel.label!r} — P2P active")
            self._dc = channel
            self._setup_dc_callbacks(channel)

        @pc.on("connectionstatechange")
        async def on_state():
            state = pc.connectionState
            logger.info(f"WebRTC state: {state}")
            if state in ("failed", "closed", "disconnected"):
                await self._close_pc()

    def _setup_dc_callbacks(self, channel):
        """Attach DataChannel message handler."""

        @channel.on("message")
        async def on_message(data):
            if isinstance(data, bytes):
                await self._handle_binary(data)

        @channel.on("close")
        def on_close():
            logger.info("DataChannel closed")
            self._dc = None

    # ── Binary message handling ───────────────────────────────────────────────

    async def _handle_binary(self, data: bytes):
        if not data:
            return
        msg_type = data[0]
        rx_time = current_time_ms()

        if msg_type == MessageType.TWIST:
            await self._handle_twist(data, rx_time)
        elif msg_type == MessageType.CLOCK_SYNC_REQUEST:
            await self._handle_clock_sync(data)
        else:
            logger.debug(f"Unknown msg type: 0x{msg_type:02x}")

    async def _handle_twist(self, data: bytes, rx_time: int):
        """Decode Twist, publish to ROS2 (optional), send P2P Ack."""
        decode_start = perf_counter_us()
        try:
            twist = TwistWithLatency.decode(data)
        except Exception as e:
            logger.error(f"Twist decode error: {e} (size={len(data)})")
            return
        decode_us = perf_counter_us() - decode_start

        twist.timestamps.t3_python_rx = rx_time
        twist.timestamps.python_decode_us = decode_us

        # Callback / ROS2 publish
        process_start = perf_counter_us()
        if self.on_twist:
            try:
                self.on_twist(twist)
            except Exception as e:
                logger.error(f"Twist callback error: {e}")
        if self._ros2:
            self._ros2.publish(twist)
        process_us = perf_counter_us() - process_start
        twist.timestamps.python_process_us = process_us

        # Build and send P2P Ack (also sets python_encode_us on twist.timestamps)
        await self._send_ack_p2p(twist)

        # ── Timestamp logging ────────────────────────────────────────────────
        ts        = twist.timestamps
        approx    = rx_time - ts.t1_browser_send   # raw, no clock correction
        total_us  = ts.python_decode_us + ts.python_process_us + ts.python_encode_us

        logger.info(
            f"Twist #{twist.message_id:>6}  "
            f"t1={ts.t1_browser_send}ms  "
            f"t3={ts.t3_python_rx}ms  "
            f"t4={ts.t4_python_ack}ms  "
            f"approx_lat={approx:+.0f}ms  "
            f"[dec={ts.python_decode_us}μs  "
            f"proc={ts.python_process_us}μs  "
            f"enc={ts.python_encode_us}μs  "
            f"total={total_us}μs]"
        )
        logger.debug(
            f"  velocities  lx={twist.linear_x:.3f}  ly={twist.linear_y:.3f}  "
            f"lz={twist.linear_z:.3f}  ax={twist.angular_x:.3f}  "
            f"ay={twist.angular_y:.3f}  az={twist.angular_z:.3f}  "
            f"mask=0x{twist.field_mask:02x}"
        )

        # Write to CSV file (if logger is configured)
        if self._ts_log:
            self._ts_log.log_twist(twist)

        # Rolling stats
        self.stats.record(approx, ts.python_decode_us, ts.python_process_us, ts.python_encode_us)

    async def _send_ack_p2p(self, twist: TwistWithLatency):
        """Encode and send a P2P Ack (45 bytes) over the DataChannel."""
        if self._dc is None or self._dc.readyState != "open":
            return

        encode_start = perf_counter_us()
        ack_time = current_time_ms()

        ts = LatencyTimestamps(
            t1_browser_send=twist.timestamps.t1_browser_send,
            t3_python_rx=twist.timestamps.t3_python_rx,
            t4_python_ack=ack_time,
            python_decode_us=twist.timestamps.python_decode_us,
            python_process_us=twist.timestamps.python_process_us,
            python_encode_us=0,  # filled after first encode
        )
        ack = TwistAck(message_id=twist.message_id, timestamps=ts)
        _ = ack.encode_p2p()  # dry run to measure encode time
        encode_us = perf_counter_us() - encode_start

        ts.python_encode_us = encode_us
        twist.timestamps.python_encode_us = encode_us
        ack = TwistAck(message_id=twist.message_id, timestamps=ts)
        payload = ack.encode_p2p()

        try:
            self._dc.send(payload)
            self.stats.ack_count += 1
            logger.debug(f"P2P Ack #{twist.message_id} sent ({len(payload)}B)")
        except Exception as e:
            logger.error(f"DataChannel send error: {e}")

    async def _handle_clock_sync(self, data: bytes):
        """Respond to a ClockSync request from the browser (P2P mode).

        Request  (10 bytes): [0x03] [t1: uint64] [CRC]
        Response (26 bytes): [0x04] [t1: uint64] [t2: uint64] [t3: uint64] [CRC]

        t2 is captured on entry (before decode) and t3 is captured just before
        encoding the response so the browser's NTP formula has tight brackets.
        """
        if self._dc is None or self._dc.readyState != "open":
            return

        t2 = current_time_ms()   # Python receive time — captured before decode
        try:
            req = ClockSyncRequest.decode(data)
        except Exception as e:
            logger.error(f"ClockSync decode error: {e}")
            return

        t3 = current_time_ms()   # Python transmit time — as late as possible
        resp = ClockSyncResponse(t1=req.t1, t2=t2, t3=t3)
        try:
            self._dc.send(resp.encode())
        except Exception as e:
            logger.error(f"ClockSync send error: {e}")
            return

        proc_us = (t3 - t2) * 1000   # ms → μs (usually 0 or 1 ms)
        logger.info(
            f"ClockSync  "
            f"t1(browser)={req.t1}ms  "
            f"t2(py_rx)={t2}ms  "
            f"t3(py_tx)={t3}ms  "
            f"proc={proc_us}μs"
        )

        if self._ts_log:
            self._ts_log.log_sync(req.t1, t2, t3)

    # ── Helpers ──────────────────────────────────────────────────────────────

    async def _send_signal(self, msg: dict):
        if self._ws and not self._ws.closed:
            try:
                await self._ws.send_str(json.dumps(msg))
            except Exception as e:
                logger.error(f"Signaling send error: {e}")

    async def _close_pc(self):
        if self._pc is not None:
            try:
                await self._pc.close()
            except Exception:
                pass
            self._pc = None
        self._dc = None
        self._browser_id = ""

    async def _cleanup(self):
        await self._close_pc()
        if self._ws and not self._ws.closed:
            await self._ws.close()
        if self._session:
            await self._session.close()
        if self._ros2:
            self._ros2.shutdown()

    def stop(self):
        self._shutdown.set()


# ─── Main ─────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(description="WebRTC P2P Twist Client")
    p.add_argument(
        "--signal", "-s",
        default="ws://localhost:8080/ws/signal",
        help="Go signaling server WebSocket URL"
    )
    p.add_argument("--topic", "-t", default=None, help="ROS2 topic name")
    p.add_argument("--verbose", "-v", action="store_true")
    p.add_argument(
        "--log-file", "-l",
        default="teleop_timestamps.csv",
        metavar="PATH",
        help="CSV file for per-message timestamp log (default: teleop_timestamps.csv)"
    )
    p.add_argument(
        "--no-log-file",
        action="store_true",
        help="Disable CSV timestamp logging entirely"
    )
    return p.parse_args()


async def main():
    args = parse_args()
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    print()
    print(f"  Signal URL : {args.signal}")
    print(f"  ROS2 topic : {args.topic or 'disabled'}")
    print(f"  Timestamp log : {'disabled' if args.no_log_file else args.log_file}")
    print()

    ts_logger = None
    if not args.no_log_file:
        ts_logger = TimestampFileLogger(args.log_file)
        ts_logger.open()

    client = P2PTwistClient(
        signal_url=args.signal,
        ros2_topic=args.topic,
        ts_logger=ts_logger,
    )

    shutdown = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, shutdown.set)

    async def stats_loop():
        while not shutdown.is_set():
            await asyncio.sleep(5.0)
            logger.info(f"Stats: {client.stats}")

    stats_task = asyncio.create_task(stats_loop())
    client_task = asyncio.create_task(client.run())

    await shutdown.wait()
    client.stop()
    stats_task.cancel()
    client_task.cancel()
    try:
        await asyncio.gather(stats_task, client_task, return_exceptions=True)
    except Exception:
        pass

    if ts_logger:
        ts_logger.close()
        logger.info(f"Timestamp log closed: {args.log_file}")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)