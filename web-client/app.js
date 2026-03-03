/**
 * Teleop Latency Dashboard — WebRTC P2P Edition
 * ===============================================
 *
 * TRANSPORT LAYER CHANGE (from original WebSocket relay):
 * -------------------------------------------------------
 * The original code sent all binary data (Twist, Ack, ClockSync) through
 * a Go WebSocket relay server.  This version uses:
 *
 *   1. sigWs  — A WebSocket to the Go *signaling* server only.
 *               Used just to exchange SDP offer/answer and ICE candidates.
 *               After the handshake it becomes idle.
 *
 *   2. dc     — An RTCDataChannel connected directly to the Python process.
 *               All binary robot-control data flows here, P2P.
 *
 * BINARY PROTOCOL CHANGES:
 * ------------------------
 * Outbound (Browser → Python):
 *   0x01 Twist:       18 + 8×N bytes (unchanged)
 *   0x03 ClockSyncReq: 9 bytes       (unchanged, now Python responds)
 *
 * Inbound (Python → Browser):
 *   0x02 P2P Ack:     45 bytes (NEW — no relay timestamps)
 *   0x04 ClockSyncResp: 25 bytes (unchanged)
 *
 * P2P Ack layout (45 bytes):
 *   [0]     uint8   type (0x02)
 *   [1-8]   uint64  message_id
 *   [9-16]  uint64  t1_browser_send
 *   [17-24] uint64  t3_python_rx  (Python clock)
 *   [25-32] uint64  t4_python_ack (Python clock)
 *   [33-36] uint32  python_decode_us
 *   [37-40] uint32  python_process_us
 *   [41-44] uint32  python_encode_us
 *
 * LATENCY MODEL (P2P):
 * --------------------
 *   t1  Browser sends Twist          (browser clock)
 *   t3p Python receives Twist        (Python clock; convert via clockOffset)
 *   t4p Python sends Ack             (Python clock)
 *   t6  Browser receives Ack         (browser clock)
 *
 *   RTT                = t6 - t1                          (browser clock, exact)
 *   one_way_to_python  = (t3p - clockOffset) - t1         (needs clock sync)
 *   python_processing  = (decode_us + process_us + encode_us) / 1000  ms
 *   one_way_return     = t6 - (t4p - clockOffset)         (needs clock sync)
 *
 * JAVASCRIPT BINARY ENCODING:
 * ----------------------------
 * ArrayBuffer + DataView, little-endian (true flag on all set/get calls).
 * BigInt required for uint64 values.  Math.floor() before BigInt to avoid
 * fractional-integer crashes.
 */

// ============ MESSAGE TYPES ============
const MSG_TWIST     = 0x01;
const MSG_ACK       = 0x02;
const MSG_SYNC_REQ  = 0x03;
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
    // Signaling server (Go) — ONLY for WebRTC handshake
    signalUrl: `ws://${location.hostname || 'localhost'}:8080/ws/signal?role=browser`,

    sendHz: 20,
    chartWindowSec: 20,
    syncIntervalMs: 10000,
    minSpeed: 1.0,
    maxSpeed: 8.0,
    defaultSpeed: 1.0,
    keyRepeatMs: 50,

    // WebRTC configuration
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],

    // Set true to enable verbose console output
    debugLog: false,
};

// ============ STATE ============
// Signaling WebSocket (Go server — ephemeral, stays connected for ICE)
let sigWs = null;
// WebRTC peer connection and data channel
let pc = null;
let dc = null;
let myPeerId = '';   // assigned by Go on connect

let connected = false;
let msgId = 0;
let history = [];
let linY = 0, angZ = 0;
let currentSpeed = CONFIG.defaultSpeed;
let fieldMask = FIELD_LINEAR_Y | FIELD_ANGULAR_Z;
let sendTimer = null;

// Keyboard state
let keysPressed = new Set();
let keyTimer = null;

// Clock sync (now syncs to Python directly via DataChannel)
let clockOffset = 0, clockRtt = 0, clockSynced = false;
let offsets = [];

// Stats
let ackCount = 0;

// ============ LOGGING HELPERS ============

function logDebug(cat, msg, data) {
    if (!CONFIG.debugLog) return;
    data !== undefined ? console.debug(`[${cat}] ${msg}`, data) : console.debug(`[${cat}] ${msg}`);
}
function logInfo(cat, msg, data) {
    data !== undefined ? console.log(`[${cat}] ${msg}`, data) : console.log(`[${cat}] ${msg}`);
}
function logWarn(cat, msg, data) {
    data !== undefined ? console.warn(`[${cat}] ${msg}`, data) : console.warn(`[${cat}] ${msg}`);
}
function logError(cat, msg, data) {
    data !== undefined ? console.error(`[${cat}] ${msg}`, data) : console.error(`[${cat}] ${msg}`);
}

// ============ BINARY ENCODING ============

/**
 * Encode Twist message (variable size: 18 + 8×N bytes).
 *
 * In P2P mode t1 is just Date.now() — no relay clock offset needed.
 * RTT = t6_receive - t1_send is measured entirely in browser time.
 */
function encodeTwist(id, t1, velocities) {
    const numFields = popcount(fieldMask);
    const size = 18 + numFields * 8;
    const buf = new ArrayBuffer(size);
    const v = new DataView(buf);

    const t1_int = Math.floor(t1);

    v.setUint8(0, MSG_TWIST);
    v.setBigUint64(1, BigInt(Math.floor(id)), true);
    v.setBigUint64(9, BigInt(t1_int), true);
    v.setUint8(17, fieldMask);

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
 * Decode P2P Ack (45 bytes) — no relay timestamp fields.
 *
 * Layout:
 *   [0]     uint8   type (0x02)
 *   [1-8]   uint64  message_id
 *   [9-16]  uint64  t1_browser_send
 *   [17-24] uint64  t3_python_rx
 *   [25-32] uint64  t4_python_ack
 *   [33-36] uint32  python_decode_us
 *   [37-40] uint32  python_process_us
 *   [41-44] uint32  python_encode_us
 */
function decodeAck(buf) {
    const v = new DataView(buf);

    if (buf.byteLength < 45) {
        logError('decode', `ack too small: ${buf.byteLength}B (expected 45)`);
        return null;
    }

    return {
        msgId:          Number(v.getBigUint64(1,  true)),
        t1_browser:     Number(v.getBigUint64(9,  true)),
        t3_python_rx:   Number(v.getBigUint64(17, true)),
        t4_python_ack:  Number(v.getBigUint64(25, true)),
        decode_us:      v.getUint32(33, true),
        process_us:     v.getUint32(37, true),
        encode_us:      v.getUint32(41, true),
    };
}

/**
 * Encode Clock Sync Request (9 bytes).
 * Identical format to relay mode — Python now handles the response.
 */
function encodeSyncReq(t1) {
    const buf = new ArrayBuffer(9);
    const v = new DataView(buf);
    v.setUint8(0, MSG_SYNC_REQ);
    v.setBigUint64(1, BigInt(Math.floor(t1)), true);
    logDebug('sync', `req t1=${Math.floor(t1)}`);
    return buf;
}

/** Decode Clock Sync Response (25 bytes) — unchanged from relay mode. */
function decodeSyncResp(buf) {
    const v = new DataView(buf);
    return {
        t1: Number(v.getBigUint64(1,  true)),
        t2: Number(v.getBigUint64(9,  true)),
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
                { label: 'RTT',            data: [], borderColor: '#00f5d4', backgroundColor: 'rgba(0,245,212,0.1)', fill: true, tension: 0.3, pointRadius: 0 },
                { label: '→Python',        data: [], borderColor: '#f72585', tension: 0.3, pointRadius: 0 },
                { label: 'Python proc',    data: [], borderColor: '#4361ee', tension: 0.3, pointRadius: 0 },
                { label: '←Python',        data: [], borderColor: '#ff6b35', tension: 0.3, pointRadius: 0 },
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

// ============ WEBRTC SIGNALING + CONNECTION ============

let syncInterval = null;

/**
 * connect() — full WebRTC setup:
 *   1. Open signaling WebSocket to Go
 *   2. Create RTCPeerConnection + RTCDataChannel
 *   3. Generate SDP offer, send to Go → Python
 *   4. Receive answer and ICE candidates
 *   5. DataChannel opens → P2P ready
 */
async function connect() {
    if (sigWs) disconnect();

    logInfo('webrtc', `Connecting to signaling: ${CONFIG.signalUrl}`);

    // ── Signaling WebSocket ──────────────────────────────────────────────────
    sigWs = new WebSocket(CONFIG.signalUrl);

    sigWs.onclose = () => {
        logInfo('signal', 'Signaling WebSocket closed');
        // DataChannel may still be alive if already connected
    };
    sigWs.onerror = (e) => logError('signal', 'Signaling WS error', e);

    // Wait for WebSocket to open before setting up RTCPeerConnection
    await new Promise((resolve, reject) => {
        sigWs.onopen = resolve;
        sigWs.onerror = reject;
    });

    logInfo('signal', 'Signaling connected — waiting for peer_ready...');

    // ── RTCPeerConnection ────────────────────────────────────────────────────
    pc = new RTCPeerConnection({ iceServers: CONFIG.iceServers });

    // Create DataChannel (browser is the offerer, so it creates the channel)
    dc = pc.createDataChannel('teleop', {
        ordered: false,           // unordered for lower latency
        maxRetransmits: 0,        // no retransmits — fresh data preferred
    });
    dc.binaryType = 'arraybuffer';

    dc.onopen = async () => {
        logInfo('webrtc', 'DataChannel open — P2P established (Go is idle)');
        setConnected(true);

        // Initial clock sync — Python will now respond directly
        logInfo('sync', 'Starting P2P clock sync (5 samples)...');
        for (let i = 0; i < 5; i++) {
            sendSyncReq();
            await sleep(200);
        }
        if (clockSynced) {
            logInfo('sync', `Clock synced to Python: offset=${clockOffset.toFixed(1)}ms rtt=${clockRtt.toFixed(1)}ms`);
        } else {
            logWarn('sync', `Clock sync incomplete (${offsets.length}/3 samples). Continuing.`);
        }

        syncInterval = setInterval(sendSyncReq, CONFIG.syncIntervalMs);
        startSending();
    };

    dc.onclose = () => {
        logInfo('webrtc', 'DataChannel closed');
        setConnected(false);
        stopSending();
        if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
    };

    dc.onerror = (e) => logError('webrtc', 'DataChannel error', e);

    dc.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        const type = new Uint8Array(e.data)[0];
        if (type === MSG_ACK)       handleAck(e.data);
        else if (type === MSG_SYNC_RESP) handleSyncResp(e.data);
        else logWarn('webrtc', `Unknown message type: 0x${type.toString(16)}`);
    };

    // ICE candidate → forward to Python via signaling
    pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        const cand = e.candidate;
        sendSignal({
            type: 'ice_candidate',
            candidate: cand.candidate,
            sdpMid: cand.sdpMid,
            sdpMLineIndex: cand.sdpMLineIndex,
        });
        logDebug('ice', 'Sent local ICE candidate');
    };

    pc.onconnectionstatechange = () => {
        logInfo('webrtc', `Connection state: ${pc.connectionState}`);
        if (pc.connectionState === 'failed') {
            logError('webrtc', 'Connection failed — try reconnecting');
            setConnected(false);
        }
    };

    // ── Signaling message handler ────────────────────────────────────────────
    sigWs.onmessage = async (e) => {
        const msg = JSON.parse(e.data);

        switch (msg.type) {
            case 'welcome':
                myPeerId = msg.peer_id;
                logInfo('signal', `My peer ID: ${myPeerId}`);
                break;

            case 'peer_ready':
                if (msg.role === 'python') {
                    logInfo('signal', 'Python peer ready — creating WebRTC offer...');
                    await createAndSendOffer();
                }
                break;

            case 'answer':
                logInfo('signal', 'Received SDP answer from Python');
                await pc.setRemoteDescription(new RTCSessionDescription({
                    type: 'answer',
                    sdp: msg.sdp,
                }));
                break;

            case 'ice_candidate':
                if (msg.candidate && pc) {
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate({
                            candidate: msg.candidate,
                            sdpMid: msg.sdpMid,
                            sdpMLineIndex: msg.sdpMLineIndex,
                        }));
                        logDebug('ice', 'Added remote ICE candidate');
                    } catch (err) {
                        logDebug('ice', `ICE candidate error (may be ok): ${err.message}`);
                    }
                }
                break;

            case 'peer_disconnected':
                if (msg.role === 'python') {
                    logWarn('signal', 'Python peer disconnected');
                    setConnected(false);
                    stopSending();
                }
                break;

            default:
                logDebug('signal', `Unknown signal: ${msg.type}`);
        }
    };
}

async function createAndSendOffer() {
    if (!pc) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ type: 'offer', sdp: pc.localDescription.sdp });
    logInfo('signal', 'Sent SDP offer');
}

function sendSignal(msg) {
    if (sigWs && sigWs.readyState === WebSocket.OPEN) {
        sigWs.send(JSON.stringify(msg));
    }
}

function disconnect() {
    stopSending();
    if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
    if (dc) { try { dc.close(); } catch(e){} dc = null; }
    if (pc) { try { pc.close(); } catch(e){} pc = null; }
    if (sigWs) { try { sigWs.close(); } catch(e){} sigWs = null; }
    setConnected(false);
    offsets = [];
    clockSynced = false;
    logInfo('webrtc', 'Disconnected');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ ACK HANDLING ============

function handleAck(buf) {
    const now_local = Date.now();
    const ack = decodeAck(buf);
    if (!ack) return;

    ackCount++;

    // RTT — pure browser clock, exact (no cross-clock correction needed)
    const rtt = now_local - ack.t1_browser;

    // Per-segment latency (requires clock sync for Python timestamps)
    // clockOffset = python_time - browser_time
    // so browser_time_of_python_event = python_event_time - clockOffset
    const t3p_browser = ack.t3_python_rx - clockOffset;
    const t4p_browser = ack.t4_python_ack - clockOffset;
    const oneway_to_python   = t3p_browser - ack.t1_browser;
    const python_processing  = (ack.decode_us + ack.process_us + ack.encode_us) / 1000;
    const oneway_from_python = now_local - t4p_browser;

    const lat = {
        rtt,
        toPython:    oneway_to_python,
        pythonMs:    python_processing,
        fromPython:  oneway_from_python,
        decode_us:   ack.decode_us,
        process_us:  ack.process_us,
        encode_us:   ack.encode_us,
        // For timestamp display
        t1: ack.t1_browser,
        t3py: ack.t3_python_rx,
        t4py: ack.t4_python_ack,
        t6: now_local,
    };

    if (rtt < 0) {
        logError('ack', `Negative RTT=${rtt}ms — clock issue?`);
    } else if (rtt > 5000) {
        logWarn('ack', `High RTT=${rtt}ms`);
    }

    if (!clockSynced && ackCount <= 3) {
        logWarn('ack', `msg=${ack.msgId} before clock sync — segments may be inaccurate`);
    }

    if (ackCount <= 5) {
        logInfo('ack', `msg=${ack.msgId} [${ackCount}/5 startup] RTT=${rtt.toFixed(1)}ms`, {
            '→Python': oneway_to_python.toFixed(1) + 'ms',
            'Python': python_processing.toFixed(2) + 'ms',
            '←Python': oneway_from_python.toFixed(1) + 'ms',
        });
    }

    logDebug('ack', `msg=${ack.msgId} RTT=${rtt.toFixed(1)}ms →Py=${oneway_to_python.toFixed(1)} proc=${python_processing.toFixed(2)} ←Py=${oneway_from_python.toFixed(1)}`);

    updateMetrics(lat);
    updateChart(lat, now_local);
    updateBreakdown(lat);
    updateTimestamps(lat);
}

function handleSyncResp(buf) {
    const t4 = Date.now();
    const r = decodeSyncResp(buf);

    const rtt    = (t4 - r.t1) - (r.t3 - r.t2);
    const offset = ((r.t2 - r.t1) + (r.t3 - t4)) / 2;

    offsets.push(offset);
    if (offsets.length > 5) offsets.shift();

    const sorted = [...offsets].sort((a, b) => a - b);
    clockOffset = sorted[Math.floor(sorted.length / 2)];
    clockRtt    = rtt;
    clockSynced = offsets.length >= 3;

    logInfo('sync', `sample=${offsets.length} rtt=${rtt.toFixed(1)}ms offset=${offset.toFixed(1)}ms → median=${clockOffset.toFixed(1)}ms synced=${clockSynced}`);

    const el_offset = document.getElementById('syncOffset');
    const el_rtt    = document.getElementById('syncRtt');
    const el_status = document.getElementById('syncStatus');
    if (el_offset) el_offset.textContent = clockOffset.toFixed(1) + ' ms';
    if (el_rtt)    el_rtt.textContent    = clockRtt.toFixed(1) + ' ms';
    if (el_status) el_status.textContent = clockSynced ? 'Synced ✓' : 'Syncing...';
}

// ============ SENDING ============

function startSending() {
    if (sendTimer) clearInterval(sendTimer);
    sendTimer = setInterval(sendTwist, 1000 / CONFIG.sendHz);
    logInfo('send', `Started sending at ${CONFIG.sendHz}Hz`);
}

function stopSending() {
    if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
}

function sendTwist() {
    if (!dc || dc.readyState !== 'open') return;
    msgId++;

    // In P2P mode, t1 is plain Date.now() (browser clock).
    // RTT = t6 - t1 will be in the same clock domain — no offset needed.
    const t1 = Date.now();
    const velocities = { lx: 0, ly: linY, lz: 0, ax: 0, ay: 0, az: angZ };
    const buf = encodeTwist(msgId, t1, velocities);

    try {
        dc.send(buf);
    } catch (e) {
        logError('send', `DataChannel send error: ${e.message}`);
    }

    const sizeEl = document.getElementById('msgSize');
    if (sizeEl) sizeEl.textContent = `${buf.byteLength}B`;
}

function sendSyncReq() {
    if (!dc || dc.readyState !== 'open') return;
    const t1 = Date.now();
    try {
        dc.send(encodeSyncReq(t1));
        logDebug('sync', `sent req t1=${t1}`);
    } catch (e) {
        logError('sync', `Send error: ${e.message}`);
    }
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

    keyTimer = setInterval(() => {
        if (keysPressed.size > 0) updateFromKeys();
    }, CONFIG.keyRepeatMs);
}

function updateFromKeys() {
    let newLinY = 0, newAngZ = 0;
    if (keysPressed.has('w') || keysPressed.has('arrowup'))    newLinY =  currentSpeed;
    if (keysPressed.has('s') || keysPressed.has('arrowdown'))  newLinY = -currentSpeed;
    if (keysPressed.has('a') || keysPressed.has('arrowleft'))  newAngZ =  currentSpeed;
    if (keysPressed.has('d') || keysPressed.has('arrowright')) newAngZ = -currentSpeed;
    if (keysPressed.has(' ')) { newLinY = 0; newAngZ = 0; }
    linY = newLinY;
    angZ = newAngZ;
    updateControlDisplay();
}

// ============ JOYSTICK ============

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
        knob.style.top  = `${cy + dy}px`;
        linY = -dy / maxR * currentSpeed;
        angZ = -dx / maxR * currentSpeed;
        updateControlDisplay();
    };

    const onMove = (e) => {
        if (!dragging) return;
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const clientX = e.clientX ?? (e.touches?.[0]?.clientX ?? rect.width/2);
        const clientY = e.clientY ?? (e.touches?.[0]?.clientY ?? rect.height/2);
        update(clientX - rect.left, clientY - rect.top);
    };

    const onEnd = () => {
        dragging = false;
        knob.style.left = '50%';
        knob.style.top  = '50%';
        linY = 0; angZ = 0;
        updateControlDisplay();
    };

    knob.addEventListener('mousedown',  () => dragging = true);
    knob.addEventListener('touchstart', () => dragging = true);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup',  onEnd);
    document.addEventListener('touchend', onEnd);
}

// ============ UI UPDATES ============

function setConnected(v) {
    connected = v;
    const dot  = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const btn  = document.getElementById('connectBtn');
    if (dot)  dot.classList.toggle('on', v);
    if (text) text.textContent = v ? 'Connected (P2P)' : 'Disconnected';
    if (btn)  btn.textContent  = v ? 'Disconnect' : 'Connect';
}

function updateControlDisplay() {
    const linEl = document.getElementById('linY');
    const angEl = document.getElementById('angZ');
    if (linEl) linEl.textContent = linY.toFixed(2);
    if (angEl) angEl.textContent = angZ.toFixed(2);
    updateKeyIndicators();
}

function updateKeyIndicators() {
    ['w','a','s','d'].forEach(k => {
        const el = document.getElementById(`key-${k}`);
        if (el) {
            const alt = k==='w'?'arrowup':k==='s'?'arrowdown':k==='a'?'arrowleft':'arrowright';
            el.classList.toggle('active', keysPressed.has(k) || keysPressed.has(alt));
        }
    });
}

function updateMetrics(lat) {
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined && !isNaN(val)) {
            el.innerHTML = val.toFixed(1) + '<span class="metric-unit">ms</span>';
        }
    };
    set('mRtt', lat.rtt);
    set('mBR',  lat.toPython);
    set('mPy',  lat.pythonMs);
    set('mPR',  lat.fromPython);
}

function updateChart(lat, now) {
    if (!chart) return;
    const cutoff = now - CONFIG.chartWindowSec * 1000;
    history.push({ time: now, ...lat });
    history = history.filter(d => d.time > cutoff);

    chart.data.labels = history.map(d => `-${((now - d.time)/1000).toFixed(1)}s`);
    chart.data.datasets[0].data = history.map(d => d.rtt);
    chart.data.datasets[1].data = history.map(d => d.toPython);
    chart.data.datasets[2].data = history.map(d => d.pythonMs);
    chart.data.datasets[3].data = history.map(d => d.fromPython);
    chart.update('none');
}

function updateBreakdown(lat) {
    const el = document.getElementById('breakdown');
    if (!el) return;

    const items = [
        { label: 'Browser → Python',  color: '#f72585', val: lat.toPython,   unit: 'ms' },
        { label: 'Python Decode',      color: '#4361ee', val: lat.decode_us,  unit: 'μs' },
        { label: 'Python Process',     color: '#4361ee', val: lat.process_us, unit: 'μs' },
        { label: 'Python Encode',      color: '#4361ee', val: lat.encode_us,  unit: 'μs' },
        { label: 'Python → Browser',   color: '#ff6b35', val: lat.fromPython, unit: 'ms' },
        { label: 'Total RTT',          color: '#00f5d4', val: lat.rtt,        unit: 'ms' },
    ];

    el.innerHTML = items.map(i => `
        <div class="breakdown-item">
            <div class="breakdown-label">
                <div class="breakdown-dot" style="background:${i.color}"></div>
                ${i.label}
            </div>
            <div class="breakdown-val" style="color:${i.color}">
                ${(i.val !== undefined && !isNaN(i.val)) ? i.val.toFixed(i.unit === 'μs' ? 0 : 2) : '--'} ${i.unit}
            </div>
        </div>
    `).join('');
}

function updateTimestamps(lat) {
    const el = document.getElementById('timestamps');
    if (!el) return;

    const fmt = (ts) => ts ? new Date(ts).toISOString().substr(11, 12) : '--';

    el.innerHTML = `
        <div class="ts-row"><span class="ts-label">t1 Browser Send</span><span class="ts-val">${fmt(lat.t1)}</span></div>
        <div class="ts-row"><span class="ts-label">t3 Python Rx</span><span class="ts-val">${fmt(lat.t3py)}</span></div>
        <div class="ts-row"><span class="ts-label">t4 Python Ack</span><span class="ts-val">${fmt(lat.t4py)}</span></div>
        <div class="ts-row"><span class="ts-label">t6 Browser Rx</span><span class="ts-val">${fmt(lat.t6)}</span></div>
        <div class="ts-row"><span class="ts-label">Clock Offset (P2P)</span><span class="ts-val">${clockOffset.toFixed(1)} ms</span></div>
    `;
}

// ============ SPEED CONTROL ============

function setupSpeedControl() {
    const slider  = document.getElementById('speedSlider');
    const display = document.getElementById('speedValue');
    if (!slider || !display) return;

    slider.min   = CONFIG.minSpeed;
    slider.max   = CONFIG.maxSpeed;
    slider.step  = 0.5;
    slider.value = CONFIG.defaultSpeed;
    display.textContent = CONFIG.defaultSpeed.toFixed(1);

    slider.addEventListener('input', (e) => {
        currentSpeed = parseFloat(e.target.value);
        display.textContent = currentSpeed.toFixed(1);
        if (keysPressed.size > 0) updateFromKeys();
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
        if (e.target.checked) fieldMask |= bit;
        else                  fieldMask &= ~bit;
        updateFieldInfo();
    });

    updateFieldInfo();
}

function updateFieldInfo() {
    const maskEl  = document.getElementById('fieldMask');
    const sizeEl  = document.getElementById('msgSize');
    const countEl = document.getElementById('fieldCount');
    const n = popcount(fieldMask);
    const size = 18 + n * 8;
    if (maskEl)  maskEl.textContent  = `0x${fieldMask.toString(16).padStart(2, '0')}`;
    if (sizeEl)  sizeEl.textContent  = `${size}B`;
    if (countEl) countEl.textContent = `${n}/6`;
}

// ============ INIT ============

function init() {
    initChart();
    setupKeyboard();
    setupJoystick();
    setupSpeedControl();
    setupFieldSelector();

    const connectBtn = document.getElementById('connectBtn');
    const stopBtn    = document.getElementById('stopBtn');
    const syncBtn    = document.getElementById('syncBtn');

    if (connectBtn) connectBtn.onclick = () => connected ? disconnect() : connect();
    if (stopBtn)    stopBtn.onclick    = sendStop;
    if (syncBtn)    syncBtn.onclick    = sendSyncReq;

    updateBreakdown({});

    logInfo('init', 'Teleop Dashboard (WebRTC P2P) initialized');
    logInfo('init', 'Transport: RTCDataChannel (signaling via Go WS, data direct P2P)');
    logInfo('init', 'Controls: WASD or Arrow Keys, Space to stop');
    logInfo('init', `Debug logging: ${CONFIG.debugLog ? 'ON' : 'OFF'} — set CONFIG.debugLog=true in console`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}