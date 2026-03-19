/**
 * Teleop Latency Dashboard — WebRTC P2P Edition
 * ===============================================
 *
 * CHANGES FROM ORIGINAL:
 * ----------------------
 * 1. IDLE PING/PONG
 *    When no movement (linY === 0 && angZ === 0), the browser no longer
 *    fires empty Twist messages.  Instead it sends a ClockSyncReq (0x03)
 *    at IDLE_PING_INTERVAL_MS cadence (1 s).  Python responds with the
 *    normal ClockSyncResp — keeping the clock offset fresh and the
 *    DataChannel alive with zero-cost binary keep-alives.
 *    When movement resumes, Twist messages flow at CONFIG.sendHz as before.
 *    State variable: twistActive / setChartActive()
 *
 * 2. DYNAMIC CHART BACKGROUND
 *    Idle  (no twist being sent) → chart canvas background = white.
 *    Active (twist messages flowing) → chart canvas background = dark (#12121a).
 *    Implemented via a uPlot `draw` hook using destination-over compositing
 *    so it paints behind all series, grid lines and axis labels.
 *    Transition is smooth: background switches the moment movement starts
 *    or stops.
 *
 * 3. CURSOR TOOLTIP (real-time hover values)
 *    A floating <div> follows the mouse inside the chart.  It is created
 *    once in initChart(), appended to <body> and positioned via
 *    position:fixed so it works regardless of scroll or overflow:hidden.
 *    The uPlot `setCursor` hook fires on every mouse move and updates:
 *      • Relative time label   (e.g. "-3.7s")
 *      • Per-series values     (RTT, →Python, Python proc, ←Python)  in ms
 *    Tooltip colours invert with the chart background so it is always
 *    legible on both white and dark.
 *    The built-in uPlot legend (legend.live = true) also still updates
 *    in the legend bar below the chart.
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

// ============ CRC-8 / SMBUS ============
function crc8(buf, length) {
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

function checkCrc(buf, label) {
    const bytes  = new Uint8Array(buf);
    const stored = bytes[bytes.length - 1];
    const calc   = crc8(bytes, bytes.length - 1);
    if (stored !== calc) {
        crcErrors++;
        logError('crc', `${label} CRC FAIL — stored=0x${stored.toString(16).padStart(2,'0')} calc=0x${calc.toString(16).padStart(2,'0')} len=${bytes.length}`);
        updateCrcDisplay();
        return false;
    }
    return true;
}

// ============ CONFIG ============
const CONFIG = {
    signalUrl: `ws://${location.hostname || 'localhost'}:8443/ws/signal?role=browser`,
    sendHz: 20,
    chartWindowSec: 20,
    syncIntervalMs: 10000,
    minSpeed: 0.05,
    maxSpeed: 1.0,
    defaultSpeed: 0.5,
    keyRepeatMs: 50,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    debugLog: false,
    tsLogEvery: 20,
    logMaxRows: 100000,
};

// ============ HIGH-RESOLUTION CLOCK ============
function now() {
    return performance.timeOrigin + performance.now();
}

// ============ STATE ============
let sigWs = null;
let pc = null;
let dc = null;
let myPeerId = '';

let connected = false;
let msgId = 0;
let linY = 0, angZ = 0;
let currentSpeed = CONFIG.defaultSpeed;
let fieldMask = FIELD_LINEAR_Y | FIELD_ANGULAR_Z;
let sendTimer = null;

// Keyboard state
let keysPressed = new Set();
let keyTimer = null;

// Clock sync
let clockOffset = 0, clockRtt = 0, clockSynced = false;
let offsets = [];

// Stats
let ackCount  = 0;
let crcErrors = 0;

// ── NEW: Idle ping / active chart state ──────────────────────────────────────
//
// twistActive     – true while the browser is actually sending Twist frames
//                   (i.e. at least one velocity component is non-zero).
//                   Drives the chart background colour.
//
// lastIdlePingMs  – performance.now() timestamp of the last idle ClockSyncReq
//                   sent so we can rate-limit to IDLE_PING_INTERVAL_MS.
//
// chartBgActive   – mirrors twistActive; read by the uPlot `draw` hook to
//                   pick white (idle) vs dark (active) canvas background.
//
// IDLE_PING_INTERVAL_MS – how often to send a ClockSyncReq when no Twist
//                   is flowing.  1 000 ms (1 Hz) keeps the DataChannel alive
//                   and the clock offset fresh without wasting bandwidth.
// ─────────────────────────────────────────────────────────────────────────────
let twistActive          = false;
let lastIdlePingMs       = 0;
let chartBgActive        = false;   // false = white, true = dark

const IDLE_PING_INTERVAL_MS = 1000; // 1 Hz idle keep-alive

// ── In-memory CSV log buffer ──────────────────────────────────────────────────
const LOG_TWIST_COLS = [
    'wall_iso', 'type', 'seq',
    'msg_id',
    't1_browser_ms', 't6_browser_rx_ms',
    'rtt_ms',
    't3_python_rx_ms', 't4_python_ack_ms',
    'clock_offset_ms',
    'to_python_ms', 'python_proc_ms', 'from_python_ms',
    'decode_us', 'process_us', 'encode_us',
];
const LOG_SYNC_COLS = [
    'wall_iso', 'type', 'seq',
    't1_browser_ms', 't2_python_rx_ms', 't3_python_tx_ms', 't4_browser_rx_ms',
    'sync_rtt_ms', 'raw_offset_ms', 'smooth_offset_ms',
];
const LOG_ALL_COLS = [...new Set([...LOG_TWIST_COLS, ...LOG_SYNC_COLS])];

let logBuffer  = [];
let logSeq     = 0;

function pushLog(row) {
    if (logBuffer.length >= CONFIG.logMaxRows) logBuffer.shift();
    logBuffer.push(row);
    const el = document.getElementById('logRowCount');
    if (el) el.textContent = logBuffer.length.toLocaleString();
}

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

// ============ CSV DOWNLOAD ============
function downloadLog() {
    if (logBuffer.length === 0) {
        logWarn('log', 'Log buffer is empty — nothing to download');
        return;
    }
    const escape = v => {
        if (v === undefined || v === null || v === '') return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n')
            ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [LOG_ALL_COLS.join(',')];
    for (const row of logBuffer) {
        lines.push(LOG_ALL_COLS.map(k => escape(row[k])).join(','));
    }
    const csv = lines.join('\r\n');
    const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `teleop_log_${ts}.csv`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    logInfo('log', `Downloaded ${logBuffer.length} rows → ${name}`);
}

function clearLog() {
    logBuffer = []; logSeq = 0;
    const el = document.getElementById('logRowCount');
    if (el) el.textContent = '0';
    logInfo('log', 'Log buffer cleared');
}

// ============ BINARY ENCODE/DECODE ============
function encodeTwist(id, t1, velocities) {
    const numFields = popcount(fieldMask);
    const payloadSize = 18 + numFields * 8;
    const size = payloadSize + 1;
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
        if (fieldMask & (1 << i)) { v.setFloat64(offset, allValues[i], true); offset += 8; }
    }
    v.setUint8(payloadSize, crc8(new Uint8Array(buf, 0, payloadSize)));
    logDebug('encode', `twist msg=${id} t1=${t1_int} size=${size}B mask=0x${fieldMask.toString(16)}`);
    return buf;
}

function decodeAck(buf) {
    const v = new DataView(buf);
    if (buf.byteLength < 46) { logError('decode', `ack too small: ${buf.byteLength}B`); return null; }
    if (!checkCrc(buf, 'ACK')) return null;
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

function encodeSyncReq(t1) {
    const buf = new ArrayBuffer(10);
    const v = new DataView(buf);
    v.setUint8(0, MSG_SYNC_REQ);
    v.setBigUint64(1, BigInt(Math.floor(t1)), true);
    v.setUint8(9, crc8(new Uint8Array(buf, 0, 9)));
    logDebug('sync', `req t1=${Math.floor(t1)}`);
    return buf;
}

function decodeSyncResp(buf) {
    if (buf.byteLength < 26) { logError('decode', `sync resp too small: ${buf.byteLength}B`); return null; }
    if (!checkCrc(buf, 'SYNC_RESP')) return null;
    const v = new DataView(buf);
    return {
        t1: Number(v.getBigUint64(1,  true)),
        t2: Number(v.getBigUint64(9,  true)),
        t3: Number(v.getBigUint64(17, true)),
    };
}

// ============ CHART STATE ============
let uplot      = null;
let autoScroll = true;
let uData = [[], [], [], [], []];

// ============ CHART (uPlot) ============

/**
 * initChart()
 * -----------
 * Three additions vs the original:
 *
 * A) `draw` hook — paints the canvas background before every render.
 *    Uses `destination-over` compositing so it lands behind all series,
 *    grid and axis content.  Colour is chosen from `chartBgActive`:
 *      false (idle)   → '#ffffff'  (white)
 *      true  (active) → '#12121a'  (original dark)
 *
 * B) `setCursor` hook — fires on every mouse-move inside the plot area.
 *    Positions a fixed <div id="chartTooltip"> near the cursor and
 *    fills it with the relative time and all four series values at
 *    the hovered data index, formatted to 2 decimal places (ms).
 *    The tooltip's colour scheme adapts to the current background.
 *
 * C) Tooltip <div> created once and appended to <body> so it is never
 *    clipped by overflow:hidden on the chart wrapper.
 */
function initChart() {
    const wrap = document.getElementById('chart');

    // ── Create floating tooltip ──────────────────────────────────────────────
    let tooltip = document.getElementById('chartTooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'chartTooltip';
        Object.assign(tooltip.style, {
            display:       'none',
            position:      'fixed',
            padding:       '8px 12px',
            borderRadius:  '6px',
            border:        '1px solid #2a2a3a',
            fontFamily:    "'JetBrains Mono', monospace",
            fontSize:      '11px',
            pointerEvents: 'none',
            zIndex:        '9999',
            whiteSpace:    'nowrap',
            lineHeight:    '1.7',
            transition:    'background 0.2s, border-color 0.2s',
        });
        document.body.appendChild(tooltip);
    }

    const CYAN    = '#00f5d4';
    const MAGENTA = '#f72585';
    const BLUE    = '#4361ee';
    const ORANGE  = '#ff6b35';
    const GRID    = 'rgba(42,42,58,0.6)';
    const TICK    = '#8a8a9a';

    const SERIES_META = [
        { label: 'RTT',          color: CYAN    },
        { label: '→Python',      color: MAGENTA },
        { label: 'Python proc',  color: BLUE    },
        { label: '←Python',      color: ORANGE  },
    ];

    const opts = {
        width:  wrap.clientWidth || 800,
        height: 260,

        cursor: {
            show:  true,
            x:     true,
            y:     true,
            focus: { prox: 16 },
            drag:  { x: true, y: false, dist: 8, uni: 20 },
        },

        scales: {
            x: { time: false },
            y: { range: (_u, dataMin, dataMax) => [0, Math.max((dataMax || 0) * 1.15, 10)] },
        },

        axes: [
            {
                stroke: TICK,
                grid:  { stroke: GRID, width: 1 },
                ticks: { stroke: GRID, width: 1 },
                size:  32,
                values: (u, vals) => {
                    const latest = u.data[0].length ? u.data[0][u.data[0].length - 1] : 0;
                    return vals.map(v => v == null ? '' : `-${(latest - v).toFixed(1)}s`);
                },
            },
            {
                stroke: TICK,
                grid:  { stroke: GRID, width: 1 },
                ticks: { stroke: GRID, width: 1 },
                size:  52,
                values: (_u, vals) => vals.map(v => v == null ? '' : `${v.toFixed(1)}`),
                label:  'ms',
                labelSize: 14,
                labelFont: '11px Space Grotesk',
                font:      '11px Space Grotesk',
            },
        ],

        series: [
            {},
            { label: 'RTT',         stroke: CYAN,    fill: 'rgba(0,245,212,0.07)', width: 2,   value: (_u, v) => v == null ? '--' : `${v.toFixed(2)} ms` },
            { label: '→Python',     stroke: MAGENTA, width: 1.5, value: (_u, v) => v == null ? '--' : `${v.toFixed(2)} ms` },
            { label: 'Python proc', stroke: BLUE,    width: 1.5, value: (_u, v) => v == null ? '--' : `${v.toFixed(2)} ms` },
            { label: '←Python',     stroke: ORANGE,  width: 1.5, value: (_u, v) => v == null ? '--' : `${v.toFixed(2)} ms` },
        ],

        legend: { show: true, live: true },

        hooks: {
            // ── A) Dynamic canvas background ────────────────────────────────
            // Fires on every uPlot redraw.  Uses destination-over so the fill
            // lands behind all series, grid and text that uPlot already drew.
            draw: [u => {
                u.ctx.save();
                u.ctx.globalCompositeOperation = 'destination-over';
                // White when idle, dark when twist messages are flowing
                u.ctx.fillStyle = chartBgActive ? '#12121a' : '#ffffff';
                u.ctx.fillRect(0, 0, u.ctx.canvas.width, u.ctx.canvas.height);
                u.ctx.restore();
            }],

            // ── B) Floating cursor tooltip ───────────────────────────────────
            // Fires on every mouse-move; u.cursor.idx is the nearest data index.
            setCursor: [u => {
                const { left, top, idx } = u.cursor;

                if (idx == null || idx < 0 || left == null || u.data[0].length === 0) {
                    tooltip.style.display = 'none';
                    return;
                }

                const tSec   = u.data[0][idx];
                if (tSec == null) { tooltip.style.display = 'none'; return; }
                const latest = u.data[0][u.data[0].length - 1] ?? tSec;

                // Choose colours based on current chart background
                const isDark   = chartBgActive;
                const valColor = isDark ? '#e8e8e8' : '#111111';
                const timeColor = isDark ? '#8a8a9a' : '#555555';

                let html = `<div style="color:${timeColor};margin-bottom:5px;border-bottom:1px solid ${isDark ? '#2a2a3a' : '#cccccc'};padding-bottom:4px;">
                     &minus;${(latest - tSec).toFixed(2)}s
                </div>`;

                for (let s = 0; s < SERIES_META.length; s++) {
                    const v = u.data[s + 1]?.[idx];
                    const valStr = (v != null && !isNaN(v)) ? `${v.toFixed(2)} ms` : '--';
                    html += `<div style="display:flex;justify-content:space-between;gap:16px;">
                        <span style="color:${SERIES_META[s].color}">${SERIES_META[s].label}</span>
                        <span style="color:${valColor};font-weight:600;">${valStr}</span>
                    </div>`;
                }

                tooltip.innerHTML = html;

                // Adapt tooltip background to chart background
                tooltip.style.background   = isDark ? 'rgba(10,10,20,0.95)' : 'rgba(248,248,255,0.97)';
                tooltip.style.borderColor  = isDark ? '#2a2a3a' : '#bbbbcc';
                tooltip.style.boxShadow    = isDark
                    ? '0 4px 16px rgba(0,0,0,0.6)'
                    : '0 4px 16px rgba(0,0,0,0.15)';

                // Position relative to viewport (position:fixed)
                const canvasRect = u.root.getBoundingClientRect();
                const px = canvasRect.left + u.bbox.left  + left;
                const py = canvasRect.top  + u.bbox.top   + (top || 0);

                tooltip.style.display = 'block';

                // Measure tooltip after setting content
                const ttW = tooltip.offsetWidth  || 180;
                const ttH = tooltip.offsetHeight || 100;
                const vW  = window.innerWidth;
                const vH  = window.innerHeight;

                // Offset 14px right and slightly above cursor; flip if near edge
                let ttLeft = px + 14;
                let ttTop  = py - ttH / 2;
                if (ttLeft + ttW > vW - 8) ttLeft = px - ttW - 14;
                if (ttTop < 4)             ttTop  = 4;
                if (ttTop + ttH > vH - 4)  ttTop  = vH - ttH - 4;

                tooltip.style.left = `${ttLeft}px`;
                tooltip.style.top  = `${ttTop}px`;
            }],

            setSelect: [() => { autoScroll = false; }],
        },
    };

    uplot = new uPlot(opts, uData, wrap);

    // Hide tooltip when mouse leaves the chart area
    wrap.addEventListener('mouseleave', () => {
        const tt = document.getElementById('chartTooltip');
        if (tt) tt.style.display = 'none';
    });

    // ── Scroll-wheel zoom ────────────────────────────────────────────────────
    wrap.addEventListener('wheel', e => {
        e.preventDefault();
        if (!uplot) return;
        autoScroll = false;
        const xMin = uplot.scales.x.min, xMax = uplot.scales.x.max;
        const range = xMax - xMin;
        const factor = e.deltaY < 0 ? 0.75 : 1.33;
        const rect = uplot.root.getBoundingClientRect();
        const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left - uplot.bbox.left) / uplot.bbox.width));
        const center   = xMin + pct * range;
        const newRange = range * factor;
        uplot.setScale('x', { min: center - pct * newRange, max: center + (1 - pct) * newRange });
    }, { passive: false });

    // ── Resize observer ──────────────────────────────────────────────────────
    new ResizeObserver(() => {
        if (uplot) uplot.setSize({ width: wrap.clientWidth, height: 260 });
    }).observe(wrap);
}

function resetZoom() {
    autoScroll = true;
    if (!uplot || !uData[0].length) return;
    const latest = uData[0][uData[0].length - 1];
    uplot.setScale('x', { min: latest - CONFIG.chartWindowSec, max: latest });
}

// ============ WEBRTC SIGNALING + CONNECTION ============
let syncInterval = null;

async function connect() {
    if (sigWs) disconnect();
    logInfo('webrtc', `Connecting to signaling: ${CONFIG.signalUrl}`);
    sigWs = new WebSocket(CONFIG.signalUrl);
    sigWs.onclose = () => logInfo('signal', 'Signaling WebSocket closed');
    sigWs.onerror = (e) => logError('signal', 'Signaling WS error', e);
    await new Promise((resolve, reject) => {
        sigWs.onopen = resolve;
        sigWs.onerror = reject;
    });
    logInfo('signal', 'Signaling connected — waiting for peer_ready...');

    pc = new RTCPeerConnection({ iceServers: CONFIG.iceServers });
    dc = pc.createDataChannel('teleop', { ordered: false, maxRetransmits: 0 });
    dc.binaryType = 'arraybuffer';

    dc.onopen = async () => {
        logInfo('webrtc', ' DataChannel open — P2P established');
        setConnected(true);
        logInfo('sync', 'Starting P2P clock sync (5 samples)...');
        for (let i = 0; i < 5; i++) { sendSyncReq(); await sleep(200); }
        if (clockSynced) {
            logInfo('sync', `Clock synced: offset=${clockOffset.toFixed(1)}ms rtt=${clockRtt.toFixed(1)}ms`);
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
        // Reset chart to idle (white) on disconnect
        twistActive = false;
        setChartActive(false);
    };

    dc.onerror   = (e) => logError('webrtc', 'DataChannel error', e);
    dc.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        const type = new Uint8Array(e.data)[0];
        if      (type === MSG_ACK)       handleAck(e.data);
        else if (type === MSG_SYNC_RESP) handleSyncResp(e.data);
        else logWarn('webrtc', `Unknown message type: 0x${type.toString(16)}`);
    };

    pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        const cand = e.candidate;
        sendSignal({ type: 'ice_candidate', candidate: cand.candidate, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex });
        logDebug('ice', 'Sent local ICE candidate');
    };
    pc.onconnectionstatechange = () => {
        logInfo('webrtc', `Connection state: ${pc.connectionState}`);
        if (pc.connectionState === 'failed') { logError('webrtc', 'Connection failed'); setConnected(false); }
    };

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
                await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
                break;
            case 'ice_candidate':
                if (msg.candidate && pc) {
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate({ candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex }));
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
    if (sigWs && sigWs.readyState === WebSocket.OPEN) sigWs.send(JSON.stringify(msg));
}

function disconnect() {
    stopSending();
    if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
    if (dc)    { try { dc.close();    } catch(e){} dc    = null; }
    if (pc)    { try { pc.close();    } catch(e){} pc    = null; }
    if (sigWs) { try { sigWs.close(); } catch(e){} sigWs = null; }
    setConnected(false);
    offsets = []; clockSynced = false;
    // Return chart to idle state on disconnect
    twistActive = false;
    setChartActive(false);
    logInfo('webrtc', 'Disconnected');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ============ ACK HANDLING ============
function handleAck(buf) {
    const t6  = now();
    const ack = decodeAck(buf);
    if (!ack) return;
    ackCount++;

    const rtt                = t6 - ack.t1_browser;
    const t3p_browser        = ack.t3_python_rx  - clockOffset;
    const t4p_browser        = ack.t4_python_ack - clockOffset;
    const oneway_to_python   = t3p_browser   - ack.t1_browser;
    const python_processing  = (ack.decode_us + ack.process_us + ack.encode_us) / 1000;
    const oneway_from_python = t6 - t4p_browser;

    const lat = {
        rtt, toPython: oneway_to_python, pythonMs: python_processing,
        fromPython: oneway_from_python,
        decode_us: ack.decode_us, process_us: ack.process_us, encode_us: ack.encode_us,
        t1: ack.t1_browser, t3py: ack.t3_python_rx, t4py: ack.t4_python_ack, t6,
    };

    if (rtt < 0) logError('ack', `Negative RTT=${rtt.toFixed(2)}ms`);
    else if (rtt > 5000) logWarn('ack', `High RTT=${rtt.toFixed(1)}ms  msg=${ack.msgId}`);
    if (!clockSynced && ackCount <= 3) logWarn('ack', `msg=${ack.msgId} — segments unreliable before clock sync`);
    if (ackCount <= 5) logInfo('ack', `msg=${ack.msgId} [startup ${ackCount}/5]  RTT=${rtt.toFixed(2)}ms  →Py=${oneway_to_python.toFixed(2)}ms  proc=${python_processing.toFixed(3)}ms  ←Py=${oneway_from_python.toFixed(2)}ms`);

    if (ackCount % CONFIG.tsLogEvery === 0) {
        console.groupCollapsed(`%c[ts] msg=${ack.msgId}  RTT=${rtt.toFixed(2)}ms`, 'color:#00f5d4');
        console.table({
            't1  browser_send':  { ms: ack.t1_browser.toFixed(3),    note: 'browser clock' },
            't3p python_rx':     { ms: ack.t3_python_rx.toFixed(0),  note: 'python clock (raw)' },
            't3p browser_equiv': { ms: t3p_browser.toFixed(3),       note: 'python_rx − clockOffset' },
            't4p python_ack':    { ms: ack.t4_python_ack.toFixed(0), note: 'python clock (raw)' },
            't4p browser_equiv': { ms: t4p_browser.toFixed(3),       note: 'python_ack − clockOffset' },
            't6  browser_rx':    { ms: t6.toFixed(3),                note: 'browser clock' },
        });
        console.groupEnd();
    }

    logDebug('ack', `msg=${ack.msgId}  RTT=${rtt.toFixed(2)}ms  →Py=${oneway_to_python.toFixed(2)}  proc=${python_processing.toFixed(3)}  ←Py=${oneway_from_python.toFixed(2)}`);

    pushLog({
        wall_iso:         new Date().toISOString(), type: 'TWIST', seq: ++logSeq,
        msg_id:           ack.msgId,
        t1_browser_ms:    ack.t1_browser.toFixed(3), t6_browser_rx_ms: t6.toFixed(3),
        rtt_ms:           rtt.toFixed(3),
        t3_python_rx_ms:  ack.t3_python_rx, t4_python_ack_ms: ack.t4_python_ack,
        clock_offset_ms:  clockOffset.toFixed(3),
        to_python_ms:     oneway_to_python.toFixed(3),
        python_proc_ms:   python_processing.toFixed(4),
        from_python_ms:   oneway_from_python.toFixed(3),
        decode_us: ack.decode_us, process_us: ack.process_us, encode_us: ack.encode_us,
    });

    updateMetrics(lat);
    updateChart(lat, t6);
    updateBreakdown(lat);
    updateTimestamps(lat);
}

function handleSyncResp(buf) {
    const t4 = now();
    const r = decodeSyncResp(buf);
    if (!r) return;

    const syncRtt   = (t4 - r.t1) - (r.t3 - r.t2);
    const rawOffset = ((r.t2 - r.t1) + (r.t3 - t4)) / 2;

    if (offsets.length >= 3) {
        const rtts   = offsets.map(o => o._rtt).filter(Boolean);
        const medRtt = rtts.sort((a,b) => a-b)[Math.floor(rtts.length/2)];
        if (syncRtt > medRtt * 3) {
            logWarn('sync', `OUTLIER REJECTED  syncRtt=${syncRtt.toFixed(2)}ms > 3×median`);
            return;
        }
    }

    offsets.push({ value: rawOffset, _rtt: syncRtt });
    if (offsets.length > 10) offsets.shift();

    const sorted    = [...offsets].map(o => o.value).sort((a, b) => a - b);
    const newMedian = sorted[Math.floor(sorted.length / 2)];
    const prevOffset = clockOffset;
    const delta      = newMedian - clockOffset;

    if (!clockSynced)           clockOffset = newMedian;
    else if (Math.abs(delta) > 50) { logWarn('sync', `large offset jump ${delta.toFixed(1)}ms — hard reset`); clockOffset = newMedian; }
    else                        clockOffset = clockOffset + delta * 0.2;

    clockRtt    = syncRtt;
    clockSynced = offsets.length >= 3;

    logInfo('sync', `sample=${offsets.length}  syncRtt=${syncRtt.toFixed(3)}ms  raw=${rawOffset.toFixed(3)}ms  median=${newMedian.toFixed(3)}ms  smooth=${clockOffset.toFixed(3)}ms  (Δ=${delta.toFixed(3)}ms)`);

    pushLog({
        wall_iso:          new Date().toISOString(), type: 'SYNC', seq: ++logSeq,
        t1_browser_ms:     r.t1.toFixed(3), t2_python_rx_ms: r.t2,
        t3_python_tx_ms:   r.t3, t4_browser_rx_ms: t4.toFixed(3),
        sync_rtt_ms:       syncRtt.toFixed(3), raw_offset_ms: rawOffset.toFixed(3),
        smooth_offset_ms:  clockOffset.toFixed(3),
    });

    const el_offset = document.getElementById('syncOffset');
    const el_rtt    = document.getElementById('syncRtt');
    const el_status = document.getElementById('syncStatus');
    if (el_offset) el_offset.textContent = clockOffset.toFixed(2) + ' ms';
    if (el_rtt)    el_rtt.textContent    = clockRtt.toFixed(2)   + ' ms';
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

/**
 * sendTwist()  —  MODIFIED (idle ping/pong + dynamic chart background)
 * ---------------------------------------------------------------------
 * Called by the 20 Hz interval timer unconditionally.
 *
 * WHEN MOVING (linY !== 0 || angZ !== 0):
 *   • Encodes and sends a Twist binary frame exactly as before.
 *   • On the first moving tick, calls setChartActive(true) to switch
 *     the chart background from white to dark.
 *
 * WHEN IDLE (linY === 0 && angZ === 0):
 *   • Does NOT send a Twist frame (no empty 0,0 messages).
 *   • Sends a ClockSyncReq (0x03, 10 bytes) at most once per
 *     IDLE_PING_INTERVAL_MS = 1 000 ms.  Python responds with a
 *     ClockSyncResp, so the ping also refreshes the clock offset.
 *   • On the first idle tick, calls setChartActive(false) to switch
 *     the chart background from dark to white.
 *
 * The 20 Hz timer itself is never stopped while connected — only the
 * payload changes.  This guarantees no gap in connectivity even when
 * the operator takes their hands off the keyboard.
 */
function sendTwist() {
    if (!dc || dc.readyState !== 'open') return;

    const isMoving = (linY !== 0 || angZ !== 0);

    if (isMoving) {
        // ── Send actual Twist message ──────────────────────────────────────
        msgId++;
        const t1 = now();
        // Map forward axis to the first enabled linear field (x → y → z priority)
        // Map turn axis to the first enabled angular field (z → x → y priority,
        // matching the ROS2 convention where angular.z is yaw).
        const velocities = { lx: 0, ly: 0, lz: 0, ax: 0, ay: 0, az: 0 };
        if      (fieldMask & FIELD_LINEAR_X) velocities.lx = linY;
        else if (fieldMask & FIELD_LINEAR_Y) velocities.ly = linY;
        else if (fieldMask & FIELD_LINEAR_Z) velocities.lz = linY;
        if      (fieldMask & FIELD_ANGULAR_Z) velocities.az = angZ;
        else if (fieldMask & FIELD_ANGULAR_X) velocities.ax = angZ;
        else if (fieldMask & FIELD_ANGULAR_Y) velocities.ay = angZ;
        const buf        = encodeTwist(msgId, t1, velocities);
        try {
            dc.send(buf);
        } catch (e) {
            logError('send', `DataChannel send error: ${e.message}`);
        }
        const sizeEl = document.getElementById('msgSize');
        if (sizeEl) sizeEl.textContent = `${buf.byteLength}B`;

        // Switch chart to dark background on first moving tick
        if (!twistActive) {
            twistActive = true;
            setChartActive(true);
            logDebug('send', 'Twist active — chart background → dark');
        }

    } else {
        // ── Idle: send ClockSyncReq as a keep-alive ping (1 Hz) ───────────
        // performance.now() is used for the rate limiter (not for the sync
        // timestamp itself — sendSyncReq() uses now() internally).
        const perfNow = performance.now();
        if (perfNow - lastIdlePingMs >= IDLE_PING_INTERVAL_MS) {
            sendSyncReq();
            lastIdlePingMs = perfNow;
            logDebug('ping', 'Idle ping (ClockSyncReq) → Python');
        }

        // Switch chart to white background on first idle tick
        if (twistActive) {
            twistActive = false;
            setChartActive(false);
            logDebug('send', 'Twist idle — chart background → white');
        }
    }
}

/**
 * setChartActive(active)
 * ----------------------
 * Flips the `chartBgActive` flag and triggers a uPlot redraw so the
 * `draw` hook can repaint the canvas background immediately.
 *
 * @param {boolean} active  true = dark background, false = white background
 */
function setChartActive(active) {
    chartBgActive = active;
    if (uplot) {
        // redraw(true) rebuilds paths AND fires hooks (including `draw`)
        uplot.redraw(true);
    }
}

function sendSyncReq() {
    if (!dc || dc.readyState !== 'open') return;
    const t1 = now();
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
    // Force one final Twist(0,0) so the robot stops immediately, then
    // the next sendTwist() call will switch to idle ping mode.
    if (dc && dc.readyState === 'open') {
        msgId++;
        const buf = encodeTwist(msgId, now(), { lx:0, ly:0, lz:0, ax:0, ay:0, az:0 });
        try { dc.send(buf); } catch(e){}
    }
    logInfo('ctrl', 'STOP sent');
}

// ============ KEYBOARD CONTROLS ============
function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;
        const key = e.key.toLowerCase();
        if (['w','s','a','d','arrowup','arrowdown','arrowleft','arrowright',' '].includes(key)) {
            e.preventDefault();
            keysPressed.add(key);
            updateFromKeys();
        }
    });
    document.addEventListener('keyup', (e) => {
        keysPressed.delete(e.key.toLowerCase());
        updateFromKeys();
    });
    keyTimer = setInterval(() => { if (keysPressed.size > 0) updateFromKeys(); }, CONFIG.keyRepeatMs);
}

function updateFromKeys() {
    let newLinY = 0, newAngZ = 0;
    if (keysPressed.has('w') || keysPressed.has('arrowup'))    newLinY =  currentSpeed;
    if (keysPressed.has('s') || keysPressed.has('arrowdown'))  newLinY = -currentSpeed;
    if (keysPressed.has('a') || keysPressed.has('arrowleft'))  newAngZ =  currentSpeed;
    if (keysPressed.has('d') || keysPressed.has('arrowright')) newAngZ = -currentSpeed;
    if (keysPressed.has(' ')) { newLinY = 0; newAngZ = 0; }
    linY = newLinY; angZ = newAngZ;
    updateControlDisplay();
}

// ============ JOYSTICK ============
function setupJoystick() {
    const container = document.getElementById('joystick');
    const knob      = document.getElementById('knob');
    if (!container || !knob) return;
    let dragging = false;

    const update = (x, y) => {
        const rect = container.getBoundingClientRect();
        const cx = rect.width/2, cy = rect.height/2;
        const maxR = (rect.width - knob.offsetWidth) / 2;
        let dx = x-cx, dy = y-cy;
        const dist = Math.hypot(dx, dy);
        if (dist > maxR) { dx = dx/dist*maxR; dy = dy/dist*maxR; }
        knob.style.left = `${cx+dx}px`; knob.style.top = `${cy+dy}px`;
        linY = -dy/maxR*currentSpeed; angZ = -dx/maxR*currentSpeed;
        updateControlDisplay();
    };

    const onMove = (e) => {
        if (!dragging) return; e.preventDefault();
        const rect = container.getBoundingClientRect();
        update((e.clientX ?? e.touches?.[0]?.clientX ?? rect.width/2)  - rect.left,
               (e.clientY ?? e.touches?.[0]?.clientY ?? rect.height/2) - rect.top);
    };
    const onEnd = () => {
        dragging = false;
        knob.style.left = '50%'; knob.style.top = '50%';
        linY = 0; angZ = 0; updateControlDisplay();
    };

    knob.addEventListener('mousedown',  () => dragging = true);
    knob.addEventListener('touchstart', () => dragging = true);
    document.addEventListener('mousemove',  onMove);
    document.addEventListener('touchmove',  onMove, { passive: false });
    document.addEventListener('mouseup',    onEnd);
    document.addEventListener('touchend',   onEnd);
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
        const el  = document.getElementById(`key-${k}`);
        const alt = k==='w'?'arrowup':k==='s'?'arrowdown':k==='a'?'arrowleft':'arrowright';
        if (el) el.classList.toggle('active', keysPressed.has(k) || keysPressed.has(alt));
    });
}

function updateCrcDisplay() {
    const el = document.getElementById('crcErrors');
    if (el) {
        el.textContent = crcErrors;
        el.style.color = crcErrors > 0 ? 'var(--magenta)' : 'var(--cyan)';
    }
}

function updateMetrics(lat) {
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined && !isNaN(val))
            el.innerHTML = val.toFixed(1) + '<span class="metric-unit">ms</span>';
    };
    set('mRtt', lat.rtt); set('mBR', lat.toPython);
    set('mPy',  lat.pythonMs); set('mPR', lat.fromPython);
}

function updateChart(lat, nowMs) {
    if (!uplot) return;
    const t      = nowMs / 1000;
    const cutoff = t - CONFIG.chartWindowSec;

    uData[0].push(t);
    uData[1].push(lat.rtt);
    uData[2].push(lat.toPython);
    uData[3].push(lat.pythonMs);
    uData[4].push(lat.fromPython);

    let start = 0;
    while (start < uData[0].length && uData[0][start] < cutoff) start++;
    if (start > 0) {
        uData = uData.map(arr => arr.slice(start));
    }

    if (autoScroll) {
        uplot.setData(uData, false);
        uplot.setScale('x', { min: cutoff, max: t });
    } else {
        uplot.setData(uData, false);
    }
}

function updateBreakdown(lat) {
    const el = document.getElementById('breakdown');
    if (!el) return;
    const items = [
        { label: 'Browser → Python', color: '#f72585', val: lat.toPython,   unit: 'ms' },
        { label: 'Python Decode',    color: '#4361ee', val: lat.decode_us,  unit: 'μs' },
        { label: 'Python Process',   color: '#4361ee', val: lat.process_us, unit: 'μs' },
        { label: 'Python Encode',    color: '#4361ee', val: lat.encode_us,  unit: 'μs' },
        { label: 'Python → Browser', color: '#ff6b35', val: lat.fromPython, unit: 'ms' },
        { label: 'Total RTT',        color: '#00f5d4', val: lat.rtt,        unit: 'ms' },
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
    const fmt = ts => ts ? new Date(ts).toISOString().substr(11, 12) : '--';
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
    slider.min = CONFIG.minSpeed; slider.max = CONFIG.maxSpeed;
    slider.step = 0.05; slider.value = CONFIG.defaultSpeed;
    display.textContent = CONFIG.defaultSpeed.toFixed(1);
    slider.addEventListener('input', (e) => {
        currentSpeed = parseFloat(e.target.value);
        display.textContent = currentSpeed.toFixed(1);
        if (keysPressed.size > 0) updateFromKeys();
    });
}

// ============ HZ SELECTOR ============
function setupHzSelector() {
    const sel     = document.getElementById('hzSelector');
    const display = document.getElementById('hzValue');
    if (!sel) return;
    sel.addEventListener('change', (e) => {
        CONFIG.sendHz = parseInt(e.target.value, 10);
        if (display) display.textContent = `${CONFIG.sendHz} Hz`;
        // Restart the send timer at the new rate if currently sending
        if (sendTimer) {
            stopSending();
            startSending();
        }
        logInfo('send', `Send rate changed to ${CONFIG.sendHz} Hz`);
    });
}

// ============ FIELD SELECTOR ============
function setupFieldSelector() {
    const container = document.getElementById('fieldSelector');
    if (!container) return;
    container.innerHTML = FIELD_ORDER.map(f => {
        const checked = (fieldMask & f.bit) ? 'checked' : '';
        return `<label class="field-toggle">
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
    const size = 18 + n * 8 + 1;
    if (maskEl)  maskEl.textContent  = `0x${fieldMask.toString(16).padStart(2,'0')}`;
    if (sizeEl)  sizeEl.textContent  = `${size}B`;
    if (countEl) countEl.textContent = `${n}/6`;
}

// ============ INIT ============
function init() {
    initChart();
    setupKeyboard();
    setupJoystick();
    setupSpeedControl();
    setupHzSelector();
    setupFieldSelector();

    const connectBtn     = document.getElementById('connectBtn');
    const stopBtn        = document.getElementById('stopBtn');
    const syncBtn        = document.getElementById('syncBtn');
    const resetZoomBtn   = document.getElementById('resetZoomBtn');
    const downloadLogBtn = document.getElementById('downloadLogBtn');
    const clearLogBtn    = document.getElementById('clearLogBtn');

    if (connectBtn)     connectBtn.onclick     = () => connected ? disconnect() : connect();
    if (stopBtn)        stopBtn.onclick        = sendStop;
    if (syncBtn)        syncBtn.onclick        = sendSyncReq;
    if (resetZoomBtn)   resetZoomBtn.onclick   = resetZoom;
    if (downloadLogBtn) downloadLogBtn.onclick = downloadLog;
    if (clearLogBtn)    clearLogBtn.onclick    = clearLog;

    updateBreakdown({});

    logInfo('init', 'Teleop Dashboard (WebRTC P2P) initialized');
    logInfo('init', 'Idle mode: ClockSyncReq sent at 1Hz instead of empty Twist');
    logInfo('init', 'Chart: white background (idle) ↔ dark background (active twist)');
    logInfo('init', 'Chart: hover to see real-time tooltip with all series values');
    logInfo('init', `Debug logging: ${CONFIG.debugLog ? 'ON' : 'OFF'} — set CONFIG.debugLog=true`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}