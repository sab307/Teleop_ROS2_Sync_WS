"""
Twist Protocol Module - Variable-Size Binary Protocol
"""

import struct
import time
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Optional


class MessageType(IntEnum):
    TWIST = 0x01
    TWIST_ACK = 0x02
    CLOCK_SYNC_REQUEST = 0x03
    CLOCK_SYNC_RESPONSE = 0x04


TWIST_HEADER_SIZE = 18
TWIST_RELAY_APPEND = 16
FIELD_ORDER = ['linear_x', 'linear_y', 'linear_z', 'angular_x', 'angular_y', 'angular_z']

TWIST_ACK_PYTHON_FORMAT = '<BQ5Q3IQ'
TWIST_ACK_PYTHON_SIZE = 69
TWIST_ACK_BROWSER_SIZE = 77

CLOCK_SYNC_REQUEST_FORMAT = '<BQ'
CLOCK_SYNC_REQUEST_SIZE = 9

CLOCK_SYNC_RESPONSE_FORMAT = '<BQQQ'
CLOCK_SYNC_RESPONSE_SIZE = 25

TWIST_BROWSER_SIZE = 65
TWIST_RELAY_SIZE = 81

P2P_TWIST_ACK_FORMAT = '<BQ3Q3I'
P2P_TWIST_ACK_SIZE = 45    # payload bytes (no CRC)
P2P_TWIST_ACK_WIRE = 46    # on-wire: payload + 1 CRC byte

# On-wire sizes for clock-sync messages (payload + 1 CRC byte)
CLOCK_SYNC_REQUEST_WIRE  = 10   # 9  + 1
CLOCK_SYNC_RESPONSE_WIRE = 26   # 25 + 1


def current_time_ms() -> int:
    return int(time.time() * 1000)

def perf_counter_us() -> int:
    return int(time.perf_counter() * 1_000_000)

def _popcount(mask: int) -> int:
    count = 0
    while mask:
        count += mask & 1
        mask >>= 1
    return count


# =============================================================================
# CRC-8 / SMBUS
# =============================================================================

def crc8(data: bytes) -> int:
    """CRC-8/SMBUS: poly=0x07, init=0x00, no input/output reflection.

    Identical to the JS crc8() in app.js — both sides always produce the
    same checksum for the same bytes.

    Known test vector: crc8(b"123456789") == 0xF4
    """
    crc = 0x00
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if (crc & 0x80) else (crc << 1) & 0xFF
    return crc


def verify_crc(data: bytes, label: str = "msg") -> bool:
    """Return True if data[-1] is the correct CRC-8 over data[:-1].

    On mismatch: logs an error via the module logger and returns False so
    callers can drop the message without catching an exception.
    Raises ValueError only if data is impossibly short (< 2 bytes).
    """
    if len(data) < 2:
        raise ValueError(f"verify_crc: {label} too short ({len(data)} B)")
    stored   = data[-1]
    computed = crc8(data[:-1])
    if stored != computed:
        import logging
        logging.getLogger(__name__).error(
            "CRC FAIL [%s] stored=0x%02x computed=0x%02x len=%d",
            label, stored, computed, len(data),
        )
        return False
    return True


@dataclass
class LatencyTimestamps:
    t1_browser_send: int = 0
    t2_relay_rx: int = 0
    t3_relay_tx: int = 0
    t4_relay_ack_rx: int = 0
    t5_relay_ack_tx: int = 0
    t3_python_rx: int = 0
    t4_python_ack: int = 0
    python_decode_us: int = 0
    python_process_us: int = 0
    python_encode_us: int = 0


@dataclass
class TwistWithLatency:
    linear_x: float = 0.0
    linear_y: float = 0.0
    linear_z: float = 0.0
    angular_x: float = 0.0
    angular_y: float = 0.0
    angular_z: float = 0.0
    message_id: int = 0
    field_mask: int = 0x3F
    timestamps: LatencyTimestamps = field(default_factory=LatencyTimestamps)

    def encode(self, mask=None) -> bytes:
        m = mask if mask is not None else self.field_mask
        header = struct.pack('<BQQB', MessageType.TWIST, self.message_id,
                             self.timestamps.t1_browser_send, m)
        all_values = [self.linear_x, self.linear_y, self.linear_z,
                      self.angular_x, self.angular_y, self.angular_z]
        payload = b''
        for i in range(6):
            if m & (1 << i):
                payload += struct.pack('<d', all_values[i])
        payload_bytes = header + payload
        return payload_bytes + bytes([crc8(payload_bytes)])  # +1 CRC → 19+8N bytes

    @classmethod
    def decode(cls, data: bytes, check_crc: bool = True) -> 'TwistWithLatency':
        """Decode a Twist message.

        Args:
            data:       raw on-wire bytes received from the DataChannel
            check_crc:  True  (default, P2P) — verify the trailing CRC byte
                                                and strip it before parsing.
                        False (legacy relay)  — no CRC byte; parse payload as-is.
        """
        min_len = TWIST_HEADER_SIZE + (1 if check_crc else 0)
        if len(data) < min_len:
            raise ValueError(f"Too short: {len(data)} < {min_len} bytes")
        if data[0] != MessageType.TWIST:
            raise ValueError(f"Expected TWIST (0x01), got 0x{data[0]:02x}")
        if check_crc:
            if not verify_crc(data, 'TWIST'):
                raise ValueError('TWIST CRC check failed — message is corrupt')
            data = data[:-1]   # strip CRC byte; parse payload only
        _, msg_id, t1 = struct.unpack('<BQQ', data[:17])
        field_mask = data[17]
        num_fields = _popcount(field_mask)
        payload_end = TWIST_HEADER_SIZE + num_fields * 8
        if len(data) < payload_end:
            raise ValueError(f"Too short for mask 0x{field_mask:02x}: {len(data)} < {payload_end}")
        velocities = struct.unpack(f'<{num_fields}d', data[TWIST_HEADER_SIZE:payload_end]) if num_fields > 0 else ()
        field_values = {name: 0.0 for name in FIELD_ORDER}
        vel_idx = 0
        for i, name in enumerate(FIELD_ORDER):
            if field_mask & (1 << i):
                field_values[name] = velocities[vel_idx]; vel_idx += 1
        timestamps = LatencyTimestamps(t1_browser_send=t1)
        if len(data) >= payload_end + TWIST_RELAY_APPEND:
            t2, t3 = struct.unpack('<QQ', data[payload_end:payload_end + 16])
            timestamps.t2_relay_rx = t2; timestamps.t3_relay_tx = t3
        return cls(message_id=msg_id, field_mask=field_mask, timestamps=timestamps, **field_values)

    def __str__(self):
        active = []
        all_vals = [self.linear_x, self.linear_y, self.linear_z,
                    self.angular_x, self.angular_y, self.angular_z]
        for i, name in enumerate(FIELD_ORDER):
            if self.field_mask & (1 << i):
                active.append(f"{name}={all_vals[i]:.2f}")
        return f"Twist#{self.message_id}[mask=0x{self.field_mask:02x} {', '.join(active) or 'empty'}]"


@dataclass
class TwistAck:
    message_id: int
    timestamps: LatencyTimestamps

    def encode(self) -> bytes:
        ts = self.timestamps
        return struct.pack(TWIST_ACK_PYTHON_FORMAT, MessageType.TWIST_ACK,
                           self.message_id, ts.t1_browser_send, ts.t2_relay_rx,
                           ts.t3_relay_tx, ts.t3_python_rx, ts.t4_python_ack,
                           ts.python_decode_us, ts.python_process_us, ts.python_encode_us, 0)

    def encode_p2p(self) -> bytes:
        """Encode P2P ack with trailing CRC-8 (46 bytes on wire)."""
        ts = self.timestamps
        payload = struct.pack(P2P_TWIST_ACK_FORMAT, MessageType.TWIST_ACK,
                           self.message_id, ts.t1_browser_send, ts.t3_python_rx,
                           ts.t4_python_ack, ts.python_decode_us,
                           ts.python_process_us, ts.python_encode_us)
        return payload + bytes([crc8(payload)])  # 45 + 1 = 46 bytes

    @classmethod
    def decode_p2p(cls, data: bytes) -> 'TwistAck':
        """Decode P2P ack (46 bytes on wire: 45 payload + 1 CRC)."""
        if len(data) < P2P_TWIST_ACK_WIRE:
            raise ValueError(f"P2P ack too short: {len(data)} < {P2P_TWIST_ACK_WIRE} (need payload+CRC)")
        if data[0] != MessageType.TWIST_ACK:
            raise ValueError(f"Expected TWIST_ACK (0x02), got 0x{data[0]:02x}")
        if not verify_crc(data[:P2P_TWIST_ACK_WIRE], 'TWIST_ACK'):
            raise ValueError('TWIST_ACK CRC check failed — message is corrupt')
        values = struct.unpack(P2P_TWIST_ACK_FORMAT, data[:P2P_TWIST_ACK_SIZE])
        timestamps = LatencyTimestamps(
            t1_browser_send=values[2], t3_python_rx=values[3], t4_python_ack=values[4],
            python_decode_us=values[5], python_process_us=values[6], python_encode_us=values[7])
        return cls(message_id=values[1], timestamps=timestamps)

    @classmethod
    def decode(cls, data: bytes) -> 'TwistAck':
        if len(data) < TWIST_ACK_PYTHON_SIZE:
            raise ValueError(f"Expected at least {TWIST_ACK_PYTHON_SIZE} bytes, got {len(data)}")
        if data[0] != MessageType.TWIST_ACK:
            raise ValueError(f"Expected TWIST_ACK (0x02), got 0x{data[0]:02x}")
        values = struct.unpack(TWIST_ACK_PYTHON_FORMAT, data[:TWIST_ACK_PYTHON_SIZE])
        timestamps = LatencyTimestamps(
            t1_browser_send=values[2], t2_relay_rx=values[3], t3_relay_tx=values[4],
            t3_python_rx=values[5], t4_python_ack=values[6], python_decode_us=values[7],
            python_process_us=values[8], python_encode_us=values[9], t4_relay_ack_rx=values[10])
        if len(data) >= TWIST_ACK_BROWSER_SIZE:
            timestamps.t5_relay_ack_tx = struct.unpack('<Q', data[TWIST_ACK_PYTHON_SIZE:TWIST_ACK_BROWSER_SIZE])[0]
        return cls(message_id=values[1], timestamps=timestamps)


@dataclass
class ClockSyncRequest:
    t1: int
    def encode(self) -> bytes:
        payload = struct.pack(CLOCK_SYNC_REQUEST_FORMAT, MessageType.CLOCK_SYNC_REQUEST, self.t1)
        return payload + bytes([crc8(payload)])  # 9 + 1 = 10 bytes
    @classmethod
    def decode(cls, data: bytes) -> 'ClockSyncRequest':
        if len(data) < CLOCK_SYNC_REQUEST_WIRE:
            raise ValueError(f"ClockSyncRequest too short: {len(data)} < {CLOCK_SYNC_REQUEST_WIRE}")
        if not verify_crc(data[:CLOCK_SYNC_REQUEST_WIRE], 'SYNC_REQ'):
            raise ValueError('ClockSyncRequest CRC check failed — message is corrupt')
        return cls(t1=struct.unpack(CLOCK_SYNC_REQUEST_FORMAT, data[:CLOCK_SYNC_REQUEST_SIZE])[1])


@dataclass
class ClockSyncResponse:
    t1: int; t2: int; t3: int
    def encode(self) -> bytes:
        payload = struct.pack(CLOCK_SYNC_RESPONSE_FORMAT, MessageType.CLOCK_SYNC_RESPONSE, self.t1, self.t2, self.t3)
        return payload + bytes([crc8(payload)])  # 25 + 1 = 26 bytes
    @classmethod
    def decode(cls, data: bytes) -> 'ClockSyncResponse':
        if len(data) < CLOCK_SYNC_RESPONSE_WIRE:
            raise ValueError(f"ClockSyncResponse too short: {len(data)} < {CLOCK_SYNC_RESPONSE_WIRE}")
        if not verify_crc(data[:CLOCK_SYNC_RESPONSE_WIRE], 'SYNC_RESP'):
            raise ValueError('ClockSyncResponse CRC check failed — message is corrupt')
        _, t1, t2, t3 = struct.unpack(CLOCK_SYNC_RESPONSE_FORMAT, data[:CLOCK_SYNC_RESPONSE_SIZE])
        return cls(t1=t1, t2=t2, t3=t3)


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.ERROR)   # show CRC error logs during test

    print("=" * 70)
    print("TWIST PROTOCOL + CRC-8/SMBUS SELF-TEST")
    print("=" * 70)

    # 1. Algorithm correctness
    print("\n1. CRC-8/SMBUS Algorithm (known test vector)")
    print("-" * 50)
    assert crc8(b"123456789") == 0xF4, f"Got 0x{crc8(b'123456789'):02X}, expected 0xF4"
    print(f"   crc8(b'123456789') = 0x{crc8(b'123456789'):02X}  OK")
    good = b"hello" + bytes([crc8(b"hello")])
    assert verify_crc(good, "good")
    bad = bytearray(good); bad[2] ^= 0xFF
    assert not verify_crc(bytes(bad), "bad")
    print("   verify_crc: happy path and corruption detection OK")

    # 2. TwistWithLatency P2P (with CRC)
    print("\n2. TwistWithLatency  P2P encode → decode (mask=0x22)")
    print("-" * 50)
    twist = TwistWithLatency(
        message_id=12345, field_mask=0x22, linear_y=1.5, angular_z=-0.75,
        timestamps=LatencyTimestamps(t1_browser_send=current_time_ms()))
    enc = twist.encode()
    expected = 18 + 2 * 8 + 1   # header + 2 fields + CRC
    print(f"   Encoded: {len(enc)} bytes (expected: {expected})")
    assert len(enc) == expected, f"Size wrong: {len(enc)}"
    dec = TwistWithLatency.decode(enc)
    assert dec.message_id == 12345 and dec.linear_y == 1.5 and dec.angular_z == -0.75
    print("   Round-trip OK")
    corrupt = bytearray(enc); corrupt[5] ^= 0xFF
    try:
        TwistWithLatency.decode(bytes(corrupt)); assert False
    except ValueError as e:
        assert "CRC" in str(e)
        print(f"   Corruption detected: {e}")

    # 3. TwistWithLatency relay (no CRC, check_crc=False)
    print("\n3. TwistWithLatency  relay decode (check_crc=False)")
    print("-" * 50)
    relay_payload = enc[:-1]    # strip CRC — relay never added one
    relay_data = relay_payload + struct.pack('<QQ', 1000000000001, 1000000000002)
    dec_relay = TwistWithLatency.decode(relay_data, check_crc=False)
    assert dec_relay.timestamps.t2_relay_rx == 1000000000001
    print("   Relay round-trip OK (check_crc=False, no CRC byte)")

    # 4. TwistAck P2P
    print("\n4. TwistAck  encode_p2p → decode_p2p")
    print("-" * 50)
    ack = TwistAck(
        message_id=99,
        timestamps=LatencyTimestamps(
            t1_browser_send=2000, t3_python_rx=2010, t4_python_ack=2011,
            python_decode_us=120, python_process_us=200, python_encode_us=80))
    p2p_enc = ack.encode_p2p()
    print(f"   Encoded: {len(p2p_enc)} bytes (expected: {P2P_TWIST_ACK_WIRE})")
    assert len(p2p_enc) == P2P_TWIST_ACK_WIRE
    p2p_dec = TwistAck.decode_p2p(p2p_enc)
    assert p2p_dec.message_id == 99 and p2p_dec.timestamps.python_decode_us == 120
    print("   Round-trip OK")
    corrupt = bytearray(p2p_enc); corrupt[10] ^= 0xFF
    try:
        TwistAck.decode_p2p(bytes(corrupt)); assert False
    except ValueError as e:
        assert "CRC" in str(e)
        print(f"   Corruption detected: {e}")

    # 5. ClockSyncRequest
    print("\n5. ClockSyncRequest  encode → decode")
    print("-" * 50)
    req_enc = ClockSyncRequest(t1=999888777).encode()
    print(f"   Encoded: {len(req_enc)} bytes (expected: {CLOCK_SYNC_REQUEST_WIRE})")
    assert len(req_enc) == CLOCK_SYNC_REQUEST_WIRE
    assert ClockSyncRequest.decode(req_enc).t1 == 999888777
    print("   Round-trip OK")

    # 6. ClockSyncResponse
    print("\n6. ClockSyncResponse  encode → decode")
    print("-" * 50)
    resp_enc = ClockSyncResponse(t1=1000, t2=1005, t3=1006).encode()
    print(f"   Encoded: {len(resp_enc)} bytes (expected: {CLOCK_SYNC_RESPONSE_WIRE})")
    assert len(resp_enc) == CLOCK_SYNC_RESPONSE_WIRE
    assert ClockSyncResponse.decode(resp_enc).t2 == 1005
    print("   Round-trip OK")

    print("\n" + "=" * 70)
    print("All tests passed!")
    print("=" * 70)