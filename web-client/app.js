/**
 * Teleop Latency Dashboard - Binary Protocol
 * 
 * BINARY ENCODING IN JAVASCRIPT
 * ==============================
 * 
 * JavaScript uses ArrayBuffer and DataView for binary data:
 * 
 * ArrayBuffer: Raw binary buffer (fixed size)
 * DataView: Interface to read/write typed values
 * 
 * ENCODING EXAMPLE:
 * -----------------
 * const buf = new ArrayBuffer(65);  // 65 bytes
 * const view = new DataView(buf);
 * 
 * // Write uint8 at offset 0
 * view.setUint8(0, 0x01);
 * 
 * // Write uint64 at offset 1 (little-endian = true)
 * view.setBigUint64(1, BigInt(12345), true);
 * 
 * // Write float64 at offset 9 (little-endian = true)
 * view.setFloat64(9, 1.5, true);
 * 
 * DECODING EXAMPLE:
 * -----------------
 * const type = view.getUint8(0);
 * const msgId = Number(view.getBigUint64(1, true));
 * const value = view.getFloat64(9, true);
 * 
 * ENDIANNESS:
 * -----------
 * Little-endian: Least significant byte first
 *   - 0x1234 stored as [0x34, 0x12]
 *   - Pass 'true' as last argument to DataView methods
 */

// ============ MESSAGE TYPES ============
const MSG_TWIST = 0x01;
const MSG_ACK = 0x02;
const MSG_SYNC_REQ = 0x03;
const MSG_SYNC_RESP = 0x04;

// ============ FIELD MASK BITS ============
const FIELD_LINEAR_X  = 0x01;
const FIELD_LINEAR_Y  = 0x02;
const FIELD_LINEAR_Z  = 0x04;
const FIELD_ANGULAR_X = 0x08;
const FIELD_ANGULAR_Y = 0x10;
const FIELD_ANGULAR_Z = 0x20;
const FIELD_ALL       = 0x3F;

const FIELD_ORDER = [
    { name: 'linear_x',  bit: FIELD_LINEAR_X,  label: 'Linear X' },
    { name: 'linear_y',  bit: FIELD_LINEAR_Y,  label: 'Linear Y' },
    { name: 'linear_z',  bit: FIELD_LINEAR_Z,  label: 'Linear Z' },
    { name: 'angular_x', bit: FIELD_ANGULAR_X, label: 'Angular X' },
    { name: 'angular_y', bit: FIELD_ANGULAR_Y, label: 'Angular Y' },
    { name: 'angular_z', bit: FIELD_ANGULAR_Z, label: 'Angular Z' },
];

function popcount(mask) {
    let count = 0;
    while (mask) { count += mask & 1; mask >>= 1; }
    return count;
}

// ============ CONFIG ============
const CONFIG = {
    wsUrl: `ws://${location.hostname || 'localhost'}:8081/ws/data?type=web`,
    sendHz: 20,
    chartWindowSec: 20,
    syncIntervalMs: 10000,
    minSpeed: 1.0,
    maxSpeed: 8.0,
    defaultSpeed: 1.0,
    keyRepeatMs: 50,
    // Logging control - set to true for verbose debug output
    debugLog: false,
};

// ============ STATE ============
let ws = null;
let connected = false;
let msgId = 0;
let history = [];
let linY = 0, angZ = 0;
let currentSpeed = CONFIG.defaultSpeed;
let fieldMask = FIELD_LINEAR_Y | FIELD_ANGULAR_Z;  // Default: only the fields you need
let sendTimer = null;

// Keyboard state
let keysPressed = new Set();
let keyTimer = null;

// Clock sync
let clockOffset = 0, clockRtt = 0, clockSynced = false;
let offsets = [];

// Stats
let ackCount = 0;
let lastAckTime = 0;

// ============ LOGGING HELPERS ============

/**
 * Structured logger with categories for easy filtering in browser console.
 * Filter in Chrome DevTools: type "[sync]" or "[send]" or "[ack]" in filter box.
 */
function logDebug(category, msg, data) {
    if (!CONFIG.debugLog) return;
    if (data !== undefined) {
        console.debug(`[${category}] ${msg}`, data);
    } else {
        console.debug(`[${category}] ${msg}`);
    }
}

function logInfo(category, msg, data) {
    if (data !== undefined) {
        console.log(`[${category}] ${msg}`, data);
    } else {
        console.log(`[${category}] ${msg}`);
    }
}

function logWarn(category, msg, data) {
    if (data !== undefined) {
        console.warn(`[${category}] ${msg}`, data);
    } else {
        console.warn(`[${category}] ${msg}`);
    }
}

function logError(category, msg, data) {
    if (data !== undefined) {
        console.error(`[${category}] ${msg}`, data);
    } else {
        console.error(`[${category}] ${msg}`);
    }
}

// ============ BINARY ENCODING ============

/**
 * Encode Twist message (variable size: 18 + 8×N bytes)
 * 
 * HEADER (18 bytes):
 *   [0]     uint8   type (0x01)
 *   [1-8]   uint64  message_id
 *   [9-16]  uint64  t1_browser_send
 *   [17]    uint8   field_mask
 * 
 * PAYLOAD (8 bytes per set bit):
 *   Only included fields, in order: lx, ly, lz, ax, ay, az
 * 
 * Examples:
 *   mask=0x22 (linear.y + angular.z) → 34 bytes
 *   mask=0x3F (all fields)           → 66 bytes
 */
function encodeTwist(id, t1, velocities) {
    const numFields = popcount(fieldMask);
    const size = 18 + numFields * 8;
    const buf = new ArrayBuffer(size);
    const v = new DataView(buf);
    
    // FIX: Math.floor() before BigInt — clockOffset is a float, so
    // Date.now() + clockOffset can be fractional (e.g. 1770319313923.5)
    // BigInt() requires an exact integer, hence the crash.
    const t1_int = Math.floor(t1);
    
    // Header
    v.setUint8(0, MSG_TWIST);
    v.setBigUint64(1, BigInt(Math.floor(id)), true);
    v.setBigUint64(9, BigInt(t1_int), true);
    v.setUint8(17, fieldMask);
    
    // Payload: only selected fields
    const allValues = [velocities.lx, velocities.ly, velocities.lz,
                       velocities.ax, velocities.ay, velocities.az];
    let offset = 18;
    for (let i = 0; i < 6; i++) {
        if (fieldMask & (1 << i)) {
            v.setFloat64(offset, allValues[i], true);
            offset += 8;
        }
    }
    
    logDebug('encode', `twist msg=${id} t1=${t1_int} size=${size}B mask=0x${fieldMask.toString(16)}`);
    
    return buf;
}

/**
 * Decode Twist Ack (77 bytes)
 * 
 * Layout:
 *   [0]     uint8   type (0x02)
 *   [1-8]   uint64  message_id
 *   [9-16]  uint64  t1_browser_send
 *   [17-24] uint64  t2_relay_rx
 *   [25-32] uint64  t3_relay_tx
 *   [33-40] uint64  t3_python_rx
 *   [41-48] uint64  t4_python_ack
 *   [49-52] uint32  python_decode_us
 *   [53-56] uint32  python_process_us
 *   [57-60] uint32  python_encode_us
 *   [61-68] uint64  t4_relay_ack_rx
 *   [69-76] uint64  t5_relay_ack_tx
 */
function decodeAck(buf) {
    const v = new DataView(buf);
    
    // Validate buffer size
    if (buf.byteLength < 77) {
        logError('decode', `ack buffer too small: ${buf.byteLength} bytes, expected 77`);
        return null;
    }
    
    const ack = {
        msgId:           Number(v.getBigUint64(1, true)),
        t1_browser:      Number(v.getBigUint64(9, true)),
        t2_relay_rx:     Number(v.getBigUint64(17, true)),
        t3_relay_tx:     Number(v.getBigUint64(25, true)),
        t3_python_rx:    Number(v.getBigUint64(33, true)),
        t4_python_ack:   Number(v.getBigUint64(41, true)),
        decode_us:       v.getUint32(49, true),
        process_us:      v.getUint32(53, true),
        encode_us:       v.getUint32(57, true),
        t4_relay_ack_rx: Number(v.getBigUint64(61, true)),
        t5_relay_ack_tx: Number(v.getBigUint64(69, true)),
    };
    
    logDebug('decode', `ack msg=${ack.msgId}`, {
        t1: ack.t1_browser,
        t2: ack.t2_relay_rx,
        t3: ack.t3_relay_tx,
        t3py: ack.t3_python_rx,
        t4py: ack.t4_python_ack,
        t4rel: ack.t4_relay_ack_rx,
        t5rel: ack.t5_relay_ack_tx,
    });
    
    return ack;
}

/**
 * Encode Clock Sync Request (9 bytes)
 */
function encodeSyncReq(t1) {
    const buf = new ArrayBuffer(9);
    const v = new DataView(buf);
    v.setUint8(0, MSG_SYNC_REQ);
    // FIX: floor here too in case t1 is fractional
    v.setBigUint64(1, BigInt(Math.floor(t1)), true);
    logDebug('sync', `req t1=${Math.floor(t1)}`);
    return buf;
}

/**
 * Decode Clock Sync Response (25 bytes)
 */
function decodeSyncResp(buf) {
    const v = new DataView(buf);
    return {
        t1: Number(v.getBigUint64(1, true)),
        t2: Number(v.getBigUint64(9, true)),
        t3: Number(v.getBigUint64(17, true)),
    };
}

// ============ CHART ============

let chart = null;

function initChart() {
    const ctx = document.getElementById('chart').getContext('2d');
    chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'RTT', data: [], borderColor: '#00f5d4', backgroundColor: 'rgba(0,245,212,0.1)', fill: true, tension: 0.3, pointRadius: 0 },
                { label: 'Browser→Relay', data: [], borderColor: '#f72585', tension: 0.3, pointRadius: 0 },
                { label: 'Relay→Python', data: [], borderColor: '#fee440', tension: 0.3, pointRadius: 0 },
                { label: 'Python', data: [], borderColor: '#4361ee', tension: 0.3, pointRadius: 0 },
                { label: 'Return', data: [], borderColor: '#ff6b35', tension: 0.3, pointRadius: 0 },
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: { grid: { color: 'rgba(42,42,58,0.5)' }, ticks: { color: '#8a8a9a', maxTicksLimit: 8 } },
                y: { grid: { color: 'rgba(42,42,58,0.5)' }, ticks: { color: '#8a8a9a' }, min: 0 }
            },
            plugins: { legend: { labels: { color: '#8a8a9a', usePointStyle: true, padding: 12 } } }
        }
    });
}

// ============ WEBSOCKET ============

let syncInterval = null;

function connect() {
    if (ws) ws.close();
    
    logInfo('ws', `Connecting to ${CONFIG.wsUrl}`);
    ws = new WebSocket(CONFIG.wsUrl);
    ws.binaryType = 'arraybuffer';
    
    ws.onopen = async () => {
        logInfo('ws', 'Connected');
        setConnected(true);
        
        // Initial clock sync - send 5 requests for robust median
        logInfo('sync', 'Starting initial clock sync (5 samples)...');
        for (let i = 0; i < 5; i++) {
            sendSyncReq();
            await sleep(200);
        }
        
        if (clockSynced) {
            logInfo('sync', `Clock sync complete: offset=${clockOffset.toFixed(1)}ms rtt=${clockRtt.toFixed(1)}ms`);
        } else {
            logWarn('sync', `Clock sync incomplete after initial burst (${offsets.length} samples). Continuing anyway.`);
        }
        
        // Start periodic sync and message sending
        syncInterval = setInterval(sendSyncReq, CONFIG.syncIntervalMs);
        startSending();
    };
    
    ws.onclose = () => {
        logInfo('ws', 'Disconnected');
        setConnected(false);
        stopSending();
        if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
    };
    
    ws.onerror = (e) => logError('ws', 'WebSocket error:', e);
    
    ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
            const type = new Uint8Array(e.data)[0];
            if (type === MSG_ACK) handleAck(e.data);
            else if (type === MSG_SYNC_RESP) handleSyncResp(e.data);
            else logWarn('ws', `Unknown message type: 0x${type.toString(16)}`);
        }
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function disconnect() {
    if (ws) { ws.close(); ws = null; }
    stopSending();
}

function handleAck(buf) {
    const now_local = Date.now();
    const ack = decodeAck(buf);
    
    // Guard against decode failure
    if (!ack) return;
    
    ackCount++;
    lastAckTime = now_local;
    
    // Convert browser receive time to relay clock domain
    // offset = relay_time - browser_time, so relay_time = browser_time + offset
    const t6_relay = Math.floor(now_local + clockOffset);
    
    const lat = {
        browserToRelay: ack.t2_relay_rx - ack.t1_browser,
        relayProc: ack.t3_relay_tx - ack.t2_relay_rx,
        relayToPython: ack.t3_python_rx - ack.t3_relay_tx,
        decode_us: ack.decode_us,
        process_us: ack.process_us,
        encode_us: ack.encode_us,
        pythonMs: (ack.decode_us + ack.process_us + ack.encode_us) / 1000,
        pythonToRelay: ack.t4_relay_ack_rx - ack.t4_python_ack,
        relayAckProc: ack.t5_relay_ack_tx - ack.t4_relay_ack_rx,
        relayToBrowser: t6_relay - ack.t5_relay_ack_tx,
        returnPath: t6_relay - ack.t4_python_ack,
        rtt: t6_relay - ack.t1_browser,
        // Raw timestamps for display (all in relay time)
        t1: ack.t1_browser,
        t2: ack.t2_relay_rx,
        t3: ack.t3_relay_tx,
        t3py: ack.t3_python_rx,
        t4py: ack.t4_python_ack,
        t4rel: ack.t4_relay_ack_rx,
        t5rel: ack.t5_relay_ack_tx,
        t6: t6_relay,
    };
    
    // ---- SANITY CHECKS ----
    // These catch clock sync issues, protocol bugs, or stale data
    
    if (!clockSynced) {
        logWarn('ack', `msg=${ack.msgId} received before clock sync complete — latency values may be inaccurate`);
    }
    
    // RTT should be positive and reasonable (< 5 seconds)
    if (lat.rtt < 0) {
        logError('ack', `msg=${ack.msgId} NEGATIVE RTT=${lat.rtt}ms — clock offset wrong? offset=${clockOffset.toFixed(1)}ms`, {
            t1_browser: ack.t1_browser,
            t6_relay: t6_relay,
            now_local: now_local,
            clockOffset: clockOffset,
        });
    } else if (lat.rtt > 5000) {
        logWarn('ack', `msg=${ack.msgId} HIGH RTT=${lat.rtt}ms — network issue or stale message?`);
    }
    
    // Each segment should be non-negative (within clock sync tolerance ~±5ms)
    const segments = [
        { name: 'browserToRelay', val: lat.browserToRelay },
        { name: 'relayProc',      val: lat.relayProc },
        { name: 'relayToPython',  val: lat.relayToPython },
        { name: 'pythonToRelay',  val: lat.pythonToRelay },
        { name: 'relayAckProc',   val: lat.relayAckProc },
        { name: 'relayToBrowser', val: lat.relayToBrowser },
    ];
    
    for (const seg of segments) {
        if (seg.val < -10) {
            logWarn('ack', `msg=${ack.msgId} NEGATIVE segment ${seg.name}=${seg.val.toFixed(1)}ms — clock sync drift?`);
        }
        if (Math.abs(seg.val) > 10000) {
            logError('ack', `msg=${ack.msgId} HUGE segment ${seg.name}=${seg.val.toFixed(1)}ms — clock domain mismatch!`, {
                clockOffset: clockOffset.toFixed(1),
                clockSynced: clockSynced,
            });
        }
    }
    
    // Check timestamp ordering: t1 < t2 < t3 < t3py < t4py < t4rel < t5rel < t6
    const tsChain = [
        { name: 't1→t2', a: ack.t1_browser,    b: ack.t2_relay_rx },
        { name: 't2→t3', a: ack.t2_relay_rx,    b: ack.t3_relay_tx },
        { name: 't3→t3py', a: ack.t3_relay_tx,  b: ack.t3_python_rx },
        { name: 't3py→t4py', a: ack.t3_python_rx, b: ack.t4_python_ack },
        { name: 't4py→t4rel', a: ack.t4_python_ack, b: ack.t4_relay_ack_rx },
        { name: 't4rel→t5rel', a: ack.t4_relay_ack_rx, b: ack.t5_relay_ack_tx },
        { name: 't5rel→t6', a: ack.t5_relay_ack_tx, b: t6_relay },
    ];
    
    for (const ts of tsChain) {
        if (ts.b < ts.a) {
            logWarn('ack', `msg=${ack.msgId} TIMESTAMP ORDER VIOLATION ${ts.name}: ${ts.a} > ${ts.b} (diff=${ts.a - ts.b}ms)`);
        }
    }
    
    // Log first 5 acks in detail to help debug startup issues
    if (ackCount <= 5) {
        logInfo('ack', `msg=${ack.msgId} [${ackCount}/5 startup] RTT=${lat.rtt.toFixed(1)}ms`, {
            segments: {
                'B→R': lat.browserToRelay.toFixed(1),
                'R_proc': lat.relayProc.toFixed(1),
                'R→Py': lat.relayToPython.toFixed(1),
                'Py_ms': lat.pythonMs.toFixed(2),
                'Py→R': lat.pythonToRelay.toFixed(1),
                'R_ack': lat.relayAckProc.toFixed(1),
                'R→B': lat.relayToBrowser.toFixed(1),
            },
            clock: {
                offset: clockOffset.toFixed(1),
                synced: clockSynced,
            },
        });
    }
    
    logDebug('ack', `msg=${ack.msgId} RTT=${lat.rtt.toFixed(1)}ms B→R=${lat.browserToRelay.toFixed(1)} R→Py=${lat.relayToPython.toFixed(1)} Py=${lat.pythonMs.toFixed(2)} Py→R=${lat.pythonToRelay.toFixed(1)} R→B=${lat.relayToBrowser.toFixed(1)}`);
    
    updateMetrics(lat);
    updateChart(lat, now_local);  // Use local time for chart x-axis
    updateBreakdown(lat);
    updateTimestamps(lat);
}

function handleSyncResp(buf) {
    const t4 = Date.now();
    const r = decodeSyncResp(buf);
    
    const rtt = (t4 - r.t1) - (r.t3 - r.t2);
    const offset = ((r.t2 - r.t1) + (r.t3 - t4)) / 2;
    
    offsets.push(offset);
    if (offsets.length > 5) offsets.shift();
    
    const sorted = [...offsets].sort((a,b) => a-b);
    clockOffset = sorted[Math.floor(sorted.length/2)];
    clockRtt = rtt;
    clockSynced = offsets.length >= 3;
    
    logInfo('sync', `sample=${offsets.length} rtt=${rtt.toFixed(1)}ms offset=${offset.toFixed(1)}ms → median=${clockOffset.toFixed(1)}ms synced=${clockSynced}`);
    
    document.getElementById('syncOffset').textContent = clockOffset.toFixed(1) + ' ms';
    document.getElementById('syncRtt').textContent = clockRtt.toFixed(1) + ' ms';
    document.getElementById('syncStatus').textContent = clockSynced ? 'Synced ✓' : 'Syncing...';
}

// ============ SENDING ============

function startSending() {
    if (sendTimer) clearInterval(sendTimer);
    sendTimer = setInterval(sendTwist, 1000 / CONFIG.sendHz);
    logInfo('send', `Started sending at ${CONFIG.sendHz}Hz`);
}

function stopSending() {
    if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
    logInfo('send', 'Stopped sending');
}

function sendTwist() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    msgId++;
    const velocities = { lx: 0, ly: linY, lz: 0, ax: 0, ay: 0, az: angZ };
    
    // Send t1 in RELAY time (local + offset) for accurate cross-clock latency
    // offset = relay_time - browser_time, so relay_time = browser_time + offset
    // FIX: Math.floor() to ensure integer for BigInt conversion
    const now = Date.now();
    const t1_relay = Math.floor(now + clockOffset);
    
    if (!clockSynced && msgId <= 3) {
        logWarn('send', `msg=${msgId} sending before clock sync — t1_relay=${t1_relay} (offset=${clockOffset.toFixed(1)})`);
    }
    
    const buf = encodeTwist(msgId, t1_relay, velocities);
    ws.send(buf);
    
    // Update size display
    const sizeEl = document.getElementById('msgSize');
    if (sizeEl) sizeEl.textContent = `${buf.byteLength}B`;
}

function sendSyncReq() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const t1 = Date.now();
    ws.send(encodeSyncReq(t1));
    logDebug('sync', `sent req t1=${t1}`);
}

function sendStop() {
    linY = 0; angZ = 0;
    updateControlDisplay();
    sendTwist();
    logInfo('ctrl', 'STOP sent');
}

// ============ KEYBOARD CONTROLS ============

function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;
        
        const key = e.key.toLowerCase();
        if (['w', 's', 'a', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) {
            e.preventDefault();
            keysPressed.add(key);
            updateFromKeys();
        }
    });
    
    document.addEventListener('keyup', (e) => {
        const key = e.key.toLowerCase();
        keysPressed.delete(key);
        updateFromKeys();
    });
    
    // Continuous update while keys held
    keyTimer = setInterval(() => {
        if (keysPressed.size > 0) {
            updateFromKeys();
        }
    }, CONFIG.keyRepeatMs);
}

function updateFromKeys() {
    let newLinY = 0;
    let newAngZ = 0;
    
    // Forward/backward (W/S or Up/Down)
    if (keysPressed.has('w') || keysPressed.has('arrowup')) {
        newLinY = currentSpeed;
    } else if (keysPressed.has('s') || keysPressed.has('arrowdown')) {
        newLinY = -currentSpeed;
    }
    
    // Left/right rotation (A/D or Left/Right)
    if (keysPressed.has('a') || keysPressed.has('arrowleft')) {
        newAngZ = currentSpeed;
    } else if (keysPressed.has('d') || keysPressed.has('arrowright')) {
        newAngZ = -currentSpeed;
    }
    
    // Space = stop
    if (keysPressed.has(' ')) {
        newLinY = 0;
        newAngZ = 0;
    }
    
    linY = newLinY;
    angZ = newAngZ;
    updateControlDisplay();
}

// ============ JOYSTICK (optional) ============

function setupJoystick() {
    const container = document.getElementById('joystick');
    const knob = document.getElementById('knob');
    if (!container || !knob) return;
    
    let dragging = false;
    
    const update = (x, y) => {
        const rect = container.getBoundingClientRect();
        const cx = rect.width / 2, cy = rect.height / 2;
        const maxR = (rect.width - knob.offsetWidth) / 2;
        
        let dx = x - cx, dy = y - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > maxR) { dx = dx/dist*maxR; dy = dy/dist*maxR; }
        
        knob.style.left = `${cx + dx}px`;
        knob.style.top = `${cy + dy}px`;
        
        // Use currentSpeed for magnitude
        linY = -dy / maxR * currentSpeed;
        angZ = -dx / maxR * currentSpeed;
        updateControlDisplay();
    };
    
    const onMove = (e) => {
        if (!dragging) return;
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const clientX = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : rect.width/2);
        const clientY = e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : rect.height/2);
        update(clientX - rect.left, clientY - rect.top);
    };
    
    const onEnd = () => {
        dragging = false;
        knob.style.left = '50%';
        knob.style.top = '50%';
        linY = 0; angZ = 0;
        updateControlDisplay();
    };
    
    knob.addEventListener('mousedown', () => dragging = true);
    knob.addEventListener('touchstart', () => dragging = true);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
}

// ============ UI UPDATES ============

function setConnected(v) {
    connected = v;
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const btn = document.getElementById('connectBtn');
    
    if (dot) dot.classList.toggle('on', v);
    if (text) text.textContent = v ? 'Connected' : 'Disconnected';
    if (btn) btn.textContent = v ? 'Disconnect' : 'Connect';
}

function updateControlDisplay() {
    const linEl = document.getElementById('linY');
    const angEl = document.getElementById('angZ');
    if (linEl) linEl.textContent = linY.toFixed(2);
    if (angEl) angEl.textContent = angZ.toFixed(2);
    
    // Update key indicators
    updateKeyIndicators();
}

function updateKeyIndicators() {
    const keys = ['w', 'a', 's', 'd'];
    keys.forEach(k => {
        const el = document.getElementById(`key-${k}`);
        if (el) {
            const altKey = k === 'w' ? 'arrowup' : k === 's' ? 'arrowdown' : k === 'a' ? 'arrowleft' : 'arrowright';
            el.classList.toggle('active', keysPressed.has(k) || keysPressed.has(altKey));
        }
    });
}

function updateMetrics(lat) {
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined && val !== null && !isNaN(val)) {
            el.innerHTML = val.toFixed(1) + '<span class="metric-unit">ms</span>';
        }
    };
    set('mRtt', lat.rtt);
    set('mBR', lat.browserToRelay);
    set('mRP', lat.relayToPython);
    set('mPy', lat.pythonMs);
    set('mPR', lat.pythonToRelay);
    set('mRB', lat.relayToBrowser);
}

function updateChart(lat, now) {
    if (!chart) return;
    
    const cutoff = now - CONFIG.chartWindowSec * 1000;
    history.push({ time: now, ...lat });
    history = history.filter(d => d.time > cutoff);
    
    chart.data.labels = history.map(d => `-${((now - d.time)/1000).toFixed(1)}s`);
    chart.data.datasets[0].data = history.map(d => d.rtt);
    chart.data.datasets[1].data = history.map(d => d.browserToRelay);
    chart.data.datasets[2].data = history.map(d => d.relayToPython);
    chart.data.datasets[3].data = history.map(d => d.pythonMs);
    chart.data.datasets[4].data = history.map(d => d.returnPath);
    chart.update('none');
}

function updateBreakdown(lat) {
    const el = document.getElementById('breakdown');
    if (!el) return;
    
    const items = [
        { label: 'Browser → Relay', color: '#f72585', val: lat.browserToRelay, unit: 'ms' },
        { label: 'Relay Forward', color: '#9b5de5', val: lat.relayProc, unit: 'ms' },
        { label: 'Relay → Python', color: '#fee440', val: lat.relayToPython, unit: 'ms' },
        { label: 'Python Decode', color: '#4361ee', val: lat.decode_us, unit: 'μs' },
        { label: 'Python Process', color: '#4361ee', val: lat.process_us, unit: 'μs' },
        { label: 'Python Encode', color: '#4361ee', val: lat.encode_us, unit: 'μs' },
        { label: 'Python → Relay', color: '#ff6b35', val: lat.pythonToRelay, unit: 'ms' },
        { label: 'Relay Ack Fwd', color: '#9b5de5', val: lat.relayAckProc, unit: 'ms' },
        { label: 'Relay → Browser', color: '#ff6b35', val: lat.relayToBrowser, unit: 'ms' },
        { label: 'Total RTT', color: '#00f5d4', val: lat.rtt, unit: 'ms' },
    ];
    
    el.innerHTML = items.map(i => `
        <div class="breakdown-item">
            <div class="breakdown-label">
                <div class="breakdown-dot" style="background:${i.color}"></div>
                ${i.label}
            </div>
            <div class="breakdown-val" style="color:${i.color}">
                ${(i.val !== undefined && i.val !== null && !isNaN(i.val)) ? i.val.toFixed(i.unit === 'μs' ? 0 : 2) : '--'} ${i.unit}
            </div>
        </div>
    `).join('');
}

function updateTimestamps(lat) {
    const el = document.getElementById('timestamps');
    if (!el) return;
    
    const formatTs = (ts) => {
        if (!ts) return '--';
        const d = new Date(ts);
        return d.toISOString().substr(11, 12); // HH:MM:SS.mmm
    };
    
    el.innerHTML = `
        <div class="ts-row"><span class="ts-label">t1 Browser Send</span><span class="ts-val">${formatTs(lat.t1)}</span></div>
        <div class="ts-row"><span class="ts-label">t2 Relay Rx</span><span class="ts-val">${formatTs(lat.t2)}</span></div>
        <div class="ts-row"><span class="ts-label">t3 Relay Tx</span><span class="ts-val">${formatTs(lat.t3)}</span></div>
        <div class="ts-row"><span class="ts-label">t3 Python Rx</span><span class="ts-val">${formatTs(lat.t3py)}</span></div>
        <div class="ts-row"><span class="ts-label">t4 Python Ack</span><span class="ts-val">${formatTs(lat.t4py)}</span></div>
        <div class="ts-row"><span class="ts-label">t4 Relay Ack Rx</span><span class="ts-val">${formatTs(lat.t4rel)}</span></div>
        <div class="ts-row"><span class="ts-label">t5 Relay Ack Tx</span><span class="ts-val">${formatTs(lat.t5rel)}</span></div>
        <div class="ts-row"><span class="ts-label">t6 Browser Rx</span><span class="ts-val">${formatTs(lat.t6)}</span></div>
    `;
}

// ============ SPEED CONTROL ============

function setupSpeedControl() {
    const slider = document.getElementById('speedSlider');
    const display = document.getElementById('speedValue');
    
    if (!slider || !display) return;
    
    slider.min = CONFIG.minSpeed;
    slider.max = CONFIG.maxSpeed;
    slider.step = 0.5;
    slider.value = CONFIG.defaultSpeed;
    display.textContent = CONFIG.defaultSpeed.toFixed(1);
    
    slider.addEventListener('input', (e) => {
        currentSpeed = parseFloat(e.target.value);
        display.textContent = currentSpeed.toFixed(1);
        
        if (keysPressed.size > 0) {
            updateFromKeys();
        }
    });
}

// ============ FIELD SELECTOR ============

function setupFieldSelector() {
    const container = document.getElementById('fieldSelector');
    if (!container) return;
    
    container.innerHTML = FIELD_ORDER.map(f => {
        const checked = (fieldMask & f.bit) ? 'checked' : '';
        return `
            <label class="field-toggle">
                <input type="checkbox" data-bit="${f.bit}" ${checked}>
                <span class="field-name">${f.label}</span>
                <span class="field-bit">0x${f.bit.toString(16).padStart(2,'0')}</span>
            </label>`;
    }).join('');
    
    container.addEventListener('change', (e) => {
        if (e.target.type !== 'checkbox') return;
        const bit = parseInt(e.target.dataset.bit);
        if (e.target.checked) {
            fieldMask |= bit;
        } else {
            fieldMask &= ~bit;
        }
        updateFieldInfo();
    });
    
    updateFieldInfo();
}

function updateFieldInfo() {
    const maskEl = document.getElementById('fieldMask');
    const sizeEl = document.getElementById('msgSize');
    const countEl = document.getElementById('fieldCount');
    
    const n = popcount(fieldMask);
    const size = 18 + n * 8;
    
    if (maskEl) maskEl.textContent = `0x${fieldMask.toString(16).padStart(2, '0')}`;
    if (sizeEl) sizeEl.textContent = `${size}B`;
    if (countEl) countEl.textContent = `${n}/6`;
}

// ============ INIT ============

function init() {
    initChart();
    setupKeyboard();
    setupJoystick();
    setupSpeedControl();
    setupFieldSelector();
    
    // Button handlers
    const connectBtn = document.getElementById('connectBtn');
    const stopBtn = document.getElementById('stopBtn');
    const syncBtn = document.getElementById('syncBtn');
    
    if (connectBtn) connectBtn.onclick = () => connected ? disconnect() : connect();
    if (stopBtn) stopBtn.onclick = sendStop;
    if (syncBtn) syncBtn.onclick = sendSyncReq;
    
    // Initialize breakdown with empty state
    updateBreakdown({});
    
    logInfo('init', 'Teleop Dashboard initialized');
    logInfo('init', 'Controls: WASD or Arrow Keys, Space to stop');
    logInfo('init', `Speed range: ${CONFIG.minSpeed} - ${CONFIG.maxSpeed}`);
    logInfo('init', `Field mask: 0x${fieldMask.toString(16)} (${popcount(fieldMask)} fields, ${18 + popcount(fieldMask)*8} bytes)`);
    logInfo('init', `Debug logging: ${CONFIG.debugLog ? 'ON' : 'OFF'} — set CONFIG.debugLog=true in console for verbose output`);
}

// Start when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}