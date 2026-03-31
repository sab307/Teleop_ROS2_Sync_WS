/**
 * modules/protocol.js
 * -------------------
 * Binary message constants, CRC-8/SMBUS codec, and encode/decode functions.
 *
 * Wire format (all little-endian):
 *   0x01  Twist     [type(1) | msgId(8) | t1(8) | mask(1) | N×float64 | crc(1)]
 *   0x02  P2P Ack   [type(1) | msgId(8) | t1(8) | t3(8) | t4(8) | dec(4) | proc(4) | enc(4) | crc(1)]
 *   0x03  SyncReq   [type(1) | t1(8) | crc(1)]
 *   0x04  SyncResp  [type(1) | t1(8) | t2(8) | t3(8) | crc(1)]
 */

import { state } from './state.js';
import { logDebug, logError } from './logger.js';

// ── Message type bytes ────────────────────────────────────────────────────────
export const MSG_TWIST     = 0x01;
export const MSG_ACK       = 0x02;
export const MSG_SYNC_REQ  = 0x03;
export const MSG_SYNC_RESP = 0x04;

// ── Field mask bits ───────────────────────────────────────────────────────────
// Bit i selects element i of the [lx, ly, lz, ax, ay, az] array.
export const FIELD_LINEAR_X  = 0x01;
export const FIELD_LINEAR_Y  = 0x02;
export const FIELD_LINEAR_Z  = 0x04;
export const FIELD_ANGULAR_X = 0x08;
export const FIELD_ANGULAR_Y = 0x10;
export const FIELD_ANGULAR_Z = 0x20;
export const FIELD_ALL       = 0x3F;

/** Ordered list used to build the Field Selector UI and iterate mask bits */
export const FIELD_ORDER = [
    { name: 'linear_x',  bit: FIELD_LINEAR_X,  label: 'Linear X'  },
    { name: 'linear_y',  bit: FIELD_LINEAR_Y,  label: 'Linear Y'  },
    { name: 'linear_z',  bit: FIELD_LINEAR_Z,  label: 'Linear Z'  },
    { name: 'angular_x', bit: FIELD_ANGULAR_X, label: 'Angular X' },
    { name: 'angular_y', bit: FIELD_ANGULAR_Y, label: 'Angular Y' },
    { name: 'angular_z', bit: FIELD_ANGULAR_Z, label: 'Angular Z' },
];

// ── Utility ───────────────────────────────────────────────────────────────────

/** High-resolution epoch timestamp in milliseconds (browser clock) */
export function now() {
    return performance.timeOrigin + performance.now();
}

/** Count set bits in a number */
export function popcount(mask) {
    let count = 0;
    while (mask) { count += mask & 1; mask >>>= 1; }
    return count;
}

// ── CRC-8 / SMBUS ─────────────────────────────────────────────────────────────
// Polynomial 0x07, init 0x00, no reflection.
// Test vector: crc8("123456789") === 0xF4

export function crc8(buf, length) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const n = (length !== undefined) ? length : bytes.length;
    let crc = 0x00;
    for (let i = 0; i < n; i++) {
        crc ^= bytes[i];
        for (let b = 0; b < 8; b++) {
            crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF;
        }
    }
    return crc;
}

/**
 * Verify the trailing CRC byte.
 * Increments state.crcErrors on failure (caller must call updateCrcDisplay).
 * @returns {boolean} true if CRC matches
 */
export function checkCrc(buf, label) {
    const bytes  = new Uint8Array(buf);
    const stored = bytes[bytes.length - 1];
    const calc   = crc8(bytes, bytes.length - 1);
    if (stored !== calc) {
        state.crcErrors++;
        logError('crc',
            `${label} CRC FAIL — stored=0x${stored.toString(16).padStart(2,'0')} ` +
            `calc=0x${calc.toString(16).padStart(2,'0')} len=${bytes.length}`);
        return false;
    }
    return true;
}

// ── Encoders ──────────────────────────────────────────────────────────────────

/**
 * Encode a Twist message.
 * Only the fields selected by state.fieldMask are included in the payload.
 *
 * @param {number} id         - Monotonic message sequence number
 * @param {number} t1         - Browser send timestamp (ms)
 * @param {{lx,ly,lz,ax,ay,az}} velocities
 * @returns {ArrayBuffer}
 */
export function encodeTwist(id, t1, velocities) {
    const mask        = state.fieldMask;
    const numFields   = popcount(mask);
    const payloadSize = 18 + numFields * 8;   // 1 type + 8 msgId + 8 t1 + 1 mask + N×8
    const buf         = new ArrayBuffer(payloadSize + 1); // +1 for CRC
    const v           = new DataView(buf);
    v.setUint8(0,     MSG_TWIST);
    v.setBigUint64(1, BigInt(Math.floor(id)), true);
    v.setBigUint64(9, BigInt(Math.floor(t1)), true);
    v.setUint8(17,    mask);
    const allValues = [velocities.lx, velocities.ly, velocities.lz,
                       velocities.ax, velocities.ay, velocities.az];
    let offset = 18;
    for (let i = 0; i < 6; i++) {
        if (mask & (1 << i)) { v.setFloat64(offset, allValues[i], true); offset += 8; }
    }
    v.setUint8(payloadSize, crc8(new Uint8Array(buf, 0, payloadSize)));
    logDebug('encode', `twist id=${id} t1=${Math.floor(t1)} size=${payloadSize + 1}B mask=0x${mask.toString(16)}`);
    return buf;
}

export function encodeSyncReq(t1) {
    const buf = new ArrayBuffer(10);
    const v   = new DataView(buf);
    v.setUint8(0,     MSG_SYNC_REQ);
    v.setBigUint64(1, BigInt(Math.floor(t1)), true);
    v.setUint8(9,     crc8(new Uint8Array(buf, 0, 9)));
    return buf;
}

// ── Decoders ──────────────────────────────────────────────────────────────────

/** @returns {object|null} null on CRC failure or truncated frame */
export function decodeAck(buf) {
    if (buf.byteLength < 46) { logError('decode', `ack too small: ${buf.byteLength}B`); return null; }
    if (!checkCrc(buf, 'ACK')) return null;
    const v = new DataView(buf);
    return {
        msgId:         Number(v.getBigUint64(1,  true)),
        t1_browser:    Number(v.getBigUint64(9,  true)),
        t3_python_rx:  Number(v.getBigUint64(17, true)),
        t4_python_ack: Number(v.getBigUint64(25, true)),
        decode_us:     v.getUint32(33, true),
        process_us:    v.getUint32(37, true),
        encode_us:     v.getUint32(41, true),
    };
}

/** @returns {object|null} null on CRC failure or truncated frame */
export function decodeSyncResp(buf) {
    if (buf.byteLength < 26) { logError('decode', `sync resp too small: ${buf.byteLength}B`); return null; }
    if (!checkCrc(buf, 'SYNC_RESP')) return null;
    const v = new DataView(buf);
    return {
        t1: Number(v.getBigUint64(1,  true)),
        t2: Number(v.getBigUint64(9,  true)),
        t3: Number(v.getBigUint64(17, true)),
    };
}
