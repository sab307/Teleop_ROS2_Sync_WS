"""
Twist Protocol Module - Variable-Size Binary Protocol
=====================================================

Binary encoding/decoding for ROS2 geometry_msgs/Twist messages
with field masking and latency timestamps.

TWIST MESSAGE FORMAT (variable size):
  Header (18 bytes):
    [0]     uint8   message_type (0x01)
    [1-8]   uint64  message_id
    [9-16]  uint64  t1_browser_send
    [17]    uint8   field_mask

  Payload (8 bytes per set bit in field_mask):
    Fields in order: linear_x, linear_y, linear_z, angular_x, angular_y, angular_z

  Relay appends (16 bytes, at end of message):
    [N]     uint64  t2_relay_rx
    [N+8]   uint64  t3_relay_tx

  Field mask bits:
    bit 0 (0x01) = linear_x
    bit 1 (0x02) = linear_y
    bit 2 (0x04) = linear_z
    bit 3 (0x08) = angular_x
    bit 4 (0x10) = angular_y
    bit 5 (0x20) = angular_z

  Examples:
    mask=0x22 (linear_y + angular_z): 18 + 16 = 34 bytes (50 with relay)
    mask=0x3F (all fields):           18 + 48 = 66 bytes (82 with relay)

Performance:
    - Encoding: ~1microsec
    - Decoding: ~1microsec
"""

import struct
import time
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Optional


# =================
# CONSTANTS
# =================

class MessageType(IntEnum):
    """Message type identifiers (first byte of every message)."""
    TWIST = 0x01
    TWIST_ACK = 0x02
    CLOCK_SYNC_REQUEST = 0x03
    CLOCK_SYNC_RESPONSE = 0x04


# ---- Twist (variable-size) ----
TWIST_HEADER_SIZE = 18      # type(1) + msg_id(8) + t1(8) + mask(1)
TWIST_HEADER_FORMAT = '<BQQ' # First 17 bytes; mask read separately
TWIST_RELAY_APPEND = 16     # t2(8) + t3(8) appended at end

# Field order matching the bitmask
FIELD_ORDER = ['linear_x', 'linear_y', 'linear_z',
               'angular_x', 'angular_y', 'angular_z']

# ---- Twist Ack (fixed-size) ----
# Python → Relay: 69 bytes
# '<BQ5Q3IQ' = type(1) + msg_id(8) + 5×timestamp(40) + 3×duration(12) + reserved(8)
TWIST_ACK_PYTHON_FORMAT = '<BQ5Q3IQ'
TWIST_ACK_PYTHON_SIZE = 69  # 1 + 8 + 40 + 12 + 8

# Relay → Browser: 77 bytes (relay fills reserved + appends t5)
TWIST_ACK_BROWSER_SIZE = 77

# ---- Clock Sync ----
CLOCK_SYNC_REQUEST_FORMAT = '<BQ'      # type + t1 = 9 bytes
CLOCK_SYNC_REQUEST_SIZE = 9

CLOCK_SYNC_RESPONSE_FORMAT = '<BQQQ'   # type + t1 + t2 + t3 = 25 bytes
CLOCK_SYNC_RESPONSE_SIZE = 25

# Legacy constants (kept for backward compatibility checks)
TWIST_BROWSER_SIZE = 65     # Old fixed format: type + msg_id + t1 + 6×float64
TWIST_RELAY_SIZE = 81       # Old fixed format with relay timestamps


# ===================
# UTILITY FUNCTIONS
# ===================

def current_time_ms() -> int:
    """Current time in milliseconds since Unix epoch."""
    return int(time.time() * 1000)


def perf_counter_us() -> int:
    """High-precision counter in microseconds (for measuring durations)."""
    return int(time.perf_counter() * 1_000_000)


def _popcount(mask: int) -> int:
    """Count set bits in a byte."""
    count = 0
    while mask:
        count += mask & 1
        mask >>= 1
    return count


# =================
# DATA CLASSES
# =================

@dataclass
class LatencyTimestamps:

    # Browser timestamps (ms)
    t1_browser_send: int = 0

    # Relay timestamps (ms)
    t2_relay_rx: int = 0
    t3_relay_tx: int = 0
    t4_relay_ack_rx: int = 0
    t5_relay_ack_tx: int = 0

    # Python timestamps and durations
    t3_python_rx: int = 0           # ms
    t4_python_ack: int = 0          # ms
    python_decode_us: int = 0       # μs
    python_process_us: int = 0      # μs
    python_encode_us: int = 0       # μs


@dataclass
class TwistWithLatency:
    """Variable-size Twist message with latency tracking.
    
    The field_mask controls which velocity fields are present in the
    binary encoding, reducing message size when not all 6 DOF are needed.
    """

    # Twist velocities (same as ROS geometry_msgs/Twist)
    linear_x: float = 0.0
    linear_y: float = 0.0
    linear_z: float = 0.0
    angular_x: float = 0.0
    angular_y: float = 0.0
    angular_z: float = 0.0

    # Tracking
    message_id: int = 0
    field_mask: int = 0x3F  # Default: all fields
    timestamps: LatencyTimestamps = field(default_factory=LatencyTimestamps)

    def encode(self, mask: Optional[int] = None) -> bytes:
        """Encode to variable-size binary format.
        
        Args:
            mask: Override field_mask for this encoding (default: use self.field_mask)
        
        Returns:
            bytes of length 18 + 8 × popcount(mask)
        """
        m = mask if mask is not None else self.field_mask

        # Header: type + msg_id + t1 + mask
        header = struct.pack(
            '<BQQB',
            MessageType.TWIST,
            self.message_id,
            self.timestamps.t1_browser_send,
            m,
        )

        # Payload: only fields with their bit set
        all_values = [self.linear_x, self.linear_y, self.linear_z,
                      self.angular_x, self.angular_y, self.angular_z]
        payload = b''
        for i in range(6):
            if m & (1 << i):
                payload += struct.pack('<d', all_values[i])

        return header + payload

    @classmethod
    def decode(cls, data: bytes) -> 'TwistWithLatency':
        """Decode from variable-size binary format.
        
        Handles both formats:
          - Variable (new): 18-byte header with field_mask, then N velocity fields
          - With relay timestamps: same as above + 16 bytes (t2 + t3) appended at end
        
        The relay appends t2/t3 at the END of whatever the browser sent,
        so we detect them by checking if there are 16 extra bytes beyond
        the header + velocity payload.
        """
        if len(data) < TWIST_HEADER_SIZE:
            raise ValueError(f"Too short: {len(data)} < {TWIST_HEADER_SIZE} bytes")

        # Verify message type
        if data[0] != MessageType.TWIST:
            raise ValueError(f"Expected TWIST (0x01), got 0x{data[0]:02x}")

        # Parse header
        _, msg_id, t1 = struct.unpack('<BQQ', data[:17])
        field_mask = data[17]

        # Calculate expected sizes
        num_fields = _popcount(field_mask)
        velocity_size = num_fields * 8
        payload_end = TWIST_HEADER_SIZE + velocity_size

        if len(data) < payload_end:
            raise ValueError(
                f"Too short for mask 0x{field_mask:02x}: "
                f"{len(data)} < {payload_end} bytes "
                f"({num_fields} fields × 8 bytes)"
            )

        # Unpack velocity values
        if num_fields > 0:
            velocities = struct.unpack(
                f'<{num_fields}d',
                data[TWIST_HEADER_SIZE:payload_end]
            )
        else:
            velocities = ()

        # Map to named fields based on mask bits
        field_values = {name: 0.0 for name in FIELD_ORDER}
        vel_idx = 0
        for i, name in enumerate(FIELD_ORDER):
            if field_mask & (1 << i):
                field_values[name] = velocities[vel_idx]
                vel_idx += 1

        # Check for relay timestamps (16 bytes appended after velocities)
        timestamps = LatencyTimestamps(t1_browser_send=t1)
        if len(data) >= payload_end + TWIST_RELAY_APPEND:
            t2, t3 = struct.unpack('<QQ', data[payload_end:payload_end + 16])
            timestamps.t2_relay_rx = t2
            timestamps.t3_relay_tx = t3

        return cls(
            message_id=msg_id,
            field_mask=field_mask,
            timestamps=timestamps,
            **field_values,
        )

    def __str__(self) -> str:
        active = []
        all_vals = [self.linear_x, self.linear_y, self.linear_z,
                    self.angular_x, self.angular_y, self.angular_z]
        for i, name in enumerate(FIELD_ORDER):
            if self.field_mask & (1 << i):
                active.append(f"{name}={all_vals[i]:.2f}")
        fields_str = ', '.join(active) if active else 'empty'
        return f"Twist#{self.message_id}[mask=0x{self.field_mask:02x} {fields_str}]"


@dataclass
class TwistAck:
    """Fixed-size acknowledgment message (69 bytes from Python, 77 to browser).
    
    Binary layout (Python sends 69 bytes):
      [0]     uint8   type (0x02)
      [1-8]   uint64  message_id
      [9-16]  uint64  t1_browser_send
      [17-24] uint64  t2_relay_rx
      [25-32] uint64  t3_relay_tx
      [33-40] uint64  t3_python_rx
      [41-48] uint64  t4_python_ack
      [49-52] uint32  python_decode_us
      [53-56] uint32  python_process_us
      [57-60] uint32  python_encode_us
      [61-68] uint64  reserved (relay fills with t4_relay_ack_rx)
    
    Relay extends to 77 bytes:
      [61-68] t4_relay_ack_rx (overwritten by relay)
      [69-76] t5_relay_ack_tx (appended by relay)
    """

    message_id: int
    timestamps: LatencyTimestamps

    def encode(self) -> bytes:
        """Encode to binary (69 bytes)."""
        ts = self.timestamps
        return struct.pack(
            TWIST_ACK_PYTHON_FORMAT,
            MessageType.TWIST_ACK,     # B: message type
            self.message_id,           # Q: message ID
            ts.t1_browser_send,        # Q: browser send time
            ts.t2_relay_rx,            # Q: relay receive time
            ts.t3_relay_tx,            # Q: relay forward time
            ts.t3_python_rx,           # Q: python receive time
            ts.t4_python_ack,          # Q: python ack time
            ts.python_decode_us,       # I: decode duration (μs)
            ts.python_process_us,      # I: process duration (μs)
            ts.python_encode_us,       # I: encode duration (μs)
            0,                         # Q: reserved for t4_relay_ack_rx
        )

    @classmethod
    def decode(cls, data: bytes) -> 'TwistAck':
        """Decode from binary (69 or 77 bytes)."""
        if len(data) < TWIST_ACK_PYTHON_SIZE:
            raise ValueError(f"Expected at least {TWIST_ACK_PYTHON_SIZE} bytes, got {len(data)}")

        if data[0] != MessageType.TWIST_ACK:
            raise ValueError(f"Expected TWIST_ACK (0x02), got 0x{data[0]:02x}")

        values = struct.unpack(TWIST_ACK_PYTHON_FORMAT, data[:TWIST_ACK_PYTHON_SIZE])
        # values: [type, msg_id, t1, t2, t3, t3_py, t4_py, dec_us, proc_us, enc_us, reserved]
        #          0     1       2   3   4   5      6      7       8        9       10

        timestamps = LatencyTimestamps(
            t1_browser_send=values[2],
            t2_relay_rx=values[3],
            t3_relay_tx=values[4],
            t3_python_rx=values[5],
            t4_python_ack=values[6],
            python_decode_us=values[7],
            python_process_us=values[8],
            python_encode_us=values[9],
            t4_relay_ack_rx=values[10],
        )

        # Check for relay-appended t5
        if len(data) >= TWIST_ACK_BROWSER_SIZE:
            t5 = struct.unpack('<Q', data[TWIST_ACK_PYTHON_SIZE:TWIST_ACK_BROWSER_SIZE])[0]
            timestamps.t5_relay_ack_tx = t5

        return cls(message_id=values[1], timestamps=timestamps)


@dataclass
class ClockSyncRequest:
    """Clock sync request (9 bytes)."""
    t1: int  # Client send time in ms

    def encode(self) -> bytes:
        return struct.pack(CLOCK_SYNC_REQUEST_FORMAT, MessageType.CLOCK_SYNC_REQUEST, self.t1)

    @classmethod
    def decode(cls, data: bytes) -> 'ClockSyncRequest':
        if len(data) < CLOCK_SYNC_REQUEST_SIZE:
            raise ValueError(f"Expected {CLOCK_SYNC_REQUEST_SIZE} bytes")
        values = struct.unpack(CLOCK_SYNC_REQUEST_FORMAT, data[:CLOCK_SYNC_REQUEST_SIZE])
        return cls(t1=values[1])


@dataclass
class ClockSyncResponse:
    """Clock sync response (25 bytes).
    
    NTP-style offset calculation:
        RTT = (t4 - t1) - (t3 - t2)
        Offset = ((t2 - t1) + (t3 - t4)) / 2
    """
    t1: int  # Original client send time
    t2: int  # Server receive time
    t3: int  # Server send time

    def encode(self) -> bytes:
        return struct.pack(CLOCK_SYNC_RESPONSE_FORMAT, MessageType.CLOCK_SYNC_RESPONSE, self.t1, self.t2, self.t3)

    @classmethod
    def decode(cls, data: bytes) -> 'ClockSyncResponse':
        if len(data) < CLOCK_SYNC_RESPONSE_SIZE:
            raise ValueError(f"Expected {CLOCK_SYNC_RESPONSE_SIZE} bytes")
        values = struct.unpack(CLOCK_SYNC_RESPONSE_FORMAT, data[:CLOCK_SYNC_RESPONSE_SIZE])
        return cls(t1=values[1], t2=values[2], t3=values[3])


# =============================================================================
# SELF-TEST
# =============================================================================

if __name__ == "__main__":
    print("=" * 70)
    print("VARIABLE-SIZE BINARY PROTOCOL TEST")
    print("=" * 70)

    # Test 1: Variable-size encoding/decoding
    print("\n1. Variable-Size Encoding (mask=0x22: linear_y + angular_z)")
    print("-" * 50)

    twist = TwistWithLatency(
        message_id=12345,
        field_mask=0x22,  # linear_y + angular_z
        linear_y=1.5,
        angular_z=-0.75,
        timestamps=LatencyTimestamps(t1_browser_send=current_time_ms())
    )

    encoded = twist.encode()
    expected_size = 18 + 2 * 8  # header + 2 fields
    print(f"   {twist}")
    print(f"   Encoded: {len(encoded)} bytes (expected: {expected_size})")
    assert len(encoded) == expected_size, f"Size mismatch: {len(encoded)} != {expected_size}"

    decoded = TwistWithLatency.decode(encoded)
    print(f" Decoded: {decoded}")
    assert decoded.message_id == 12345
    assert decoded.linear_y == 1.5
    assert decoded.angular_z == -0.75
    assert decoded.linear_x == 0.0  # Not in mask → default
    assert decoded.field_mask == 0x22
    print("  Round-trip OK")

    # Test 2: With relay timestamps appended
    print("\n2. With Relay Timestamps (simulating Go relay)")
    print("-" * 50)

    t2, t3 = 1000000000001, 1000000000002
    relay_data = encoded + struct.pack('<QQ', t2, t3)
    print(f"   Browser: {len(encoded)}B + relay: 16B = {len(relay_data)}B")

    decoded_relay = TwistWithLatency.decode(relay_data)
    print(f"   t2_relay_rx: {decoded_relay.timestamps.t2_relay_rx}")
    print(f"   t3_relay_tx: {decoded_relay.timestamps.t3_relay_tx}")
    assert decoded_relay.timestamps.t2_relay_rx == t2
    assert decoded_relay.timestamps.t3_relay_tx == t3
    assert decoded_relay.linear_y == 1.5
    print("  Relay timestamps decoded correctly")

    # Test 3: All fields (mask=0x3F)
    print("\n3. All Fields (mask=0x3F)")
    print("-" * 50)

    twist_all = TwistWithLatency(
        message_id=99,
        field_mask=0x3F,
        linear_x=1.0, linear_y=2.0, linear_z=3.0,
        angular_x=4.0, angular_y=5.0, angular_z=6.0,
        timestamps=LatencyTimestamps(t1_browser_send=current_time_ms())
    )
    enc_all = twist_all.encode()
    expected_all = 18 + 6 * 8
    print(f"   Encoded: {len(enc_all)} bytes (expected: {expected_all})")
    assert len(enc_all) == expected_all

    dec_all = TwistWithLatency.decode(enc_all)
    assert dec_all.linear_x == 1.0
    assert dec_all.angular_z == 6.0
    print("  All 6 fields round-trip OK")

    # Test 4: Single field
    print("\n4. Single Field (mask=0x02: linear_y only)")
    print("-" * 50)

    twist_one = TwistWithLatency(
        message_id=1, field_mask=0x02, linear_y=3.14,
        timestamps=LatencyTimestamps(t1_browser_send=current_time_ms())
    )
    enc_one = twist_one.encode()
    expected_one = 18 + 1 * 8
    print(f"   Encoded: {len(enc_one)} bytes (expected: {expected_one})")
    assert len(enc_one) == expected_one

    dec_one = TwistWithLatency.decode(enc_one)
    assert dec_one.linear_y == 3.14
    assert dec_one.linear_x == 0.0
    print("  Single field OK")

    # Test 5: Empty mask
    print("\n5. Empty Mask (mask=0x00)")
    print("-" * 50)

    twist_empty = TwistWithLatency(
        message_id=2, field_mask=0x00,
        timestamps=LatencyTimestamps(t1_browser_send=current_time_ms())
    )
    enc_empty = twist_empty.encode()
    print(f"   Encoded: {len(enc_empty)} bytes (expected: 18)")
    assert len(enc_empty) == 18
    dec_empty = TwistWithLatency.decode(enc_empty)
    assert dec_empty.linear_y == 0.0
    print("   Empty mask OK")

    # Test 6: TwistAck
    print("\n6. TwistAck Encoding/Decoding")
    print("-" * 50)

    ack = TwistAck(
        message_id=12345,
        timestamps=LatencyTimestamps(
            t1_browser_send=1000, t2_relay_rx=1005, t3_relay_tx=1006,
            t3_python_rx=1010, t4_python_ack=1015,
            python_decode_us=50, python_process_us=100, python_encode_us=30
        )
    )
    ack_enc = ack.encode()
    print(f"   Encoded: {len(ack_enc)} bytes (expected: 69)")
    assert len(ack_enc) == TWIST_ACK_PYTHON_SIZE

    ack_dec = TwistAck.decode(ack_enc)
    assert ack_dec.message_id == 12345
    assert ack_dec.timestamps.t2_relay_rx == 1005
    assert ack_dec.timestamps.python_decode_us == 50
    print("Ack round-trip OK")

    # Test 7: Performance
    print("\n7. Performance (100,000 iterations, mask=0x22)")
    print("-" * 50)

    import time as t

    iterations = 100000

    start = t.perf_counter_ns()
    for _ in range(iterations):
        data = twist.encode()
    encode_ns = (t.perf_counter_ns() - start) / iterations

    # Simulate relay-appended data
    relay_test = data + struct.pack('<QQ', 1000, 1001)

    start = t.perf_counter_ns()
    for _ in range(iterations):
        TwistWithLatency.decode(relay_test)
    decode_ns = (t.perf_counter_ns() - start) / iterations

    print(f"   Encode: {encode_ns/1000:.2f} μs/msg ({1_000_000_000/encode_ns:,.0f} msg/s)")
    print(f"   Decode: {decode_ns/1000:.2f} μs/msg ({1_000_000_000/decode_ns:,.0f} msg/s)")

    print("\n" + "=" * 70)
    print("All tests passed!")
    print("=" * 70)