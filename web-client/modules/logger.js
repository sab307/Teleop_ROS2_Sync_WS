/**
 * modules/logger.js
 * -----------------
 * Console logging helpers and in-memory CSV log buffer with download support.
 */

import { CONFIG } from './config.js';
import { state } from './state.js';

// ── CSV column definitions ────────────────────────────────────────────────────
const LOG_TWIST_COLS = [
    'wall_iso', 'type', 'seq', 'msg_id',
    't1_browser_ms', 't6_browser_rx_ms', 'rtt_ms',
    't3_python_rx_ms', 't4_python_ack_ms', 'clock_offset_ms',
    'to_python_ms', 'python_proc_ms', 'from_python_ms',
    'decode_us', 'process_us', 'encode_us',
];
const LOG_SYNC_COLS = [
    'wall_iso', 'type', 'seq',
    't1_browser_ms', 't2_python_rx_ms', 't3_python_tx_ms', 't4_browser_rx_ms',
    'sync_rtt_ms', 'raw_offset_ms', 'smooth_offset_ms',
];
export const LOG_ALL_COLS = [...new Set([...LOG_TWIST_COLS, ...LOG_SYNC_COLS])];

// ── Buffer helpers ────────────────────────────────────────────────────────────

export function pushLog(row) {
    if (state.logBuffer.length >= CONFIG.logMaxRows) state.logBuffer.shift();
    state.logBuffer.push(row);
    const el = document.getElementById('logRowCount');
    if (el) el.textContent = state.logBuffer.length.toLocaleString();
}

export function downloadLog() {
    if (state.logBuffer.length === 0) { logWarn('log', 'Log buffer empty — nothing to download'); return; }
    const escape = v => {
        if (v === undefined || v === null || v === '') return '';
        const s = String(v);
        return (s.includes(',') || s.includes('"') || s.includes('\n'))
            ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [LOG_ALL_COLS.join(',')];
    for (const row of state.logBuffer)
        lines.push(LOG_ALL_COLS.map(k => escape(row[k])).join(','));
    const csv  = lines.join('\r\n');
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `teleop_log_${ts}.csv`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    logInfo('log', `Downloaded ${state.logBuffer.length} rows → ${name}`);
}

export function clearLog() {
    state.logBuffer = []; state.logSeq = 0;
    const el = document.getElementById('logRowCount');
    if (el) el.textContent = '0';
    logInfo('log', 'Log buffer cleared');
}

// ── Console helpers ───────────────────────────────────────────────────────────

export function logDebug(cat, msg, data) {
    if (!CONFIG.debugLog) return;
    data !== undefined ? console.debug(`[${cat}] ${msg}`, data) : console.debug(`[${cat}] ${msg}`);
}
export function logInfo(cat, msg, data) {
    data !== undefined ? console.log(`[${cat}] ${msg}`, data) : console.log(`[${cat}] ${msg}`);
}
export function logWarn(cat, msg, data) {
    data !== undefined ? console.warn(`[${cat}] ${msg}`, data) : console.warn(`[${cat}] ${msg}`);
}
export function logError(cat, msg, data) {
    data !== undefined ? console.error(`[${cat}] ${msg}`, data) : console.error(`[${cat}] ${msg}`);
}
