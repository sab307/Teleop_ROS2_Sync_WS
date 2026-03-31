/**
 * modules/ui.js
 * -------------
 * All DOM read/write helpers: metric cards, breakdown, timestamps, clock-sync
 * display, speed slider, Hz selector wiring, and field-mask selector.
 *
 * Note: setupHzSelector is intentionally kept in app.js because it restarts
 * the send timer — a concern owned by the orchestrator.
 */

import { CONFIG }       from './config.js';
import { state }        from './state.js';
import { FIELD_ORDER, popcount } from './protocol.js';

// ── Connection badge ──────────────────────────────────────────────────────────

export function setConnected(v) {
    state.connected = v;
    const dot  = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const btn  = document.getElementById('connectBtn');
    if (dot)  dot.classList.toggle('on', v);
    if (text) text.textContent = v ? 'Connected (P2P)' : 'Disconnected';
    if (btn)  btn.textContent  = v ? 'Disconnect'      : 'Connect';
}

// ── Velocity display ──────────────────────────────────────────────────────────

export function updateControlDisplay() {
    const effLinY = state.gpActive ? state.gpLinY : state.linY;
    const effAngZ = state.gpActive ? state.gpAngZ : state.angZ;
    const linEl   = document.getElementById('linY');
    const angEl   = document.getElementById('angZ');
    if (linEl) linEl.textContent = effLinY.toFixed(2);
    if (angEl) angEl.textContent = effAngZ.toFixed(2);
    updateKeyIndicators();
}

export function updateKeyIndicators() {
    ['w','a','s','d'].forEach(k => {
        const el  = document.getElementById(`key-${k}`);
        const alt = k==='w'?'arrowup' : k==='s'?'arrowdown' : k==='a'?'arrowleft' : 'arrowright';
        if (el) el.classList.toggle('active', state.keysPressed.has(k) || state.keysPressed.has(alt));
    });
}

// ── CRC error counter ────────────────────────────────────────────────────────

export function updateCrcDisplay() {
    const el = document.getElementById('crcErrors');
    if (el) {
        el.textContent = state.crcErrors;
        el.style.color = state.crcErrors > 0 ? 'var(--magenta)' : 'var(--cyan)';
    }
}

// ── Latency metrics ───────────────────────────────────────────────────────────

export function updateMetrics(lat) {
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined && !isNaN(val))
            el.innerHTML = val.toFixed(1) + '<span class="metric-unit">ms</span>';
    };
    set('mRtt', lat.rtt);
    set('mBR',  lat.toPython);
    set('mPy',  lat.pythonMs);
    set('mPR',  lat.fromPython);
}

export function updateBreakdown(lat) {
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
                ${(i.val !== undefined && !isNaN(i.val))
                    ? i.val.toFixed(i.unit === 'μs' ? 0 : 2)
                    : '--'} ${i.unit}
            </div>
        </div>`).join('');
}

export function updateTimestamps(lat) {
    const el = document.getElementById('timestamps');
    if (!el) return;
    const fmt = ts => ts ? new Date(ts).toISOString().substr(11, 12) : '--';
    el.innerHTML = `
        <div class="ts-row"><span class="ts-label">t1 Browser Send</span><span class="ts-val">${fmt(lat.t1)}</span></div>
        <div class="ts-row"><span class="ts-label">t3 Python Rx</span><span class="ts-val">${fmt(lat.t3py)}</span></div>
        <div class="ts-row"><span class="ts-label">t4 Python Ack</span><span class="ts-val">${fmt(lat.t4py)}</span></div>
        <div class="ts-row"><span class="ts-label">t6 Browser Rx</span><span class="ts-val">${fmt(lat.t6)}</span></div>
        <div class="ts-row"><span class="ts-label">Clock Offset</span><span class="ts-val">${state.clockOffset.toFixed(1)} ms</span></div>`;
}

// ── Field mask info ───────────────────────────────────────────────────────────

export function updateFieldInfo() {
    const n    = popcount(state.fieldMask);
    const size = 18 + n * 8 + 1;
    const maskEl  = document.getElementById('fieldMask');
    const sizeEl  = document.getElementById('msgSize');
    const countEl = document.getElementById('fieldCount');
    if (maskEl)  maskEl.textContent  = `0x${state.fieldMask.toString(16).padStart(2,'0')}`;
    if (sizeEl)  sizeEl.textContent  = `${size}B`;
    if (countEl) countEl.textContent = `${n}/6`;
}

// ── Setup functions ───────────────────────────────────────────────────────────

export function setupSpeedControl() {
    const slider  = document.getElementById('speedSlider');
    const display = document.getElementById('speedValue');
    if (!slider) return;
    slider.min   = CONFIG.minSpeed;
    slider.max   = CONFIG.maxSpeed;
    slider.step  = 0.05;
    slider.value = CONFIG.defaultSpeed;
    state.currentSpeed = CONFIG.defaultSpeed;
    if (display) display.textContent = CONFIG.defaultSpeed.toFixed(2);
    slider.addEventListener('input', (e) => {
        state.currentSpeed = parseFloat(e.target.value);
        if (display) display.textContent = state.currentSpeed.toFixed(2);
    });
}

export function setupFieldSelector() {
    const container = document.getElementById('fieldSelector');
    if (!container) return;
    container.innerHTML = FIELD_ORDER.map(f => {
        const checked = (state.fieldMask & f.bit) ? 'checked' : '';
        return `<label class="field-toggle">
                    <input type="checkbox" data-bit="${f.bit}" ${checked}>
                    <span class="field-name">${f.label}</span>
                    <span class="field-bit">0x${f.bit.toString(16).padStart(2,'0')}</span>
                </label>`;
    }).join('');
    container.addEventListener('change', (e) => {
        if (e.target.type !== 'checkbox') return;
        const bit = parseInt(e.target.dataset.bit);
        if (e.target.checked) state.fieldMask |=  bit;
        else                  state.fieldMask &= ~bit;
        updateFieldInfo();
    });
    updateFieldInfo();
}
