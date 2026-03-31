/**
 * modules/connection.js
 * ----------------------
 * WebRTC signaling over WebSocket and DataChannel lifecycle management.
 *
 * The module writes connection state into the shared `state` object and
 * dispatches incoming binary messages through `handlers` (set by app.js)
 * to avoid a circular import dependency.
 */

import { CONFIG }                          from './config.js';
import { state, handlers }                 from './state.js';
import { MSG_ACK, MSG_SYNC_RESP,
         encodeSyncReq, now }              from './protocol.js';
import { logDebug, logInfo, logWarn,
         logError }                        from './logger.js';
import { setConnected }                    from './ui.js';
import { setChartActive }                  from './chart.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function sendSignal(msg) {
    if (state.sigWs && state.sigWs.readyState === WebSocket.OPEN)
        state.sigWs.send(JSON.stringify(msg));
}

export function sendSyncReq() {
    if (!state.dc || state.dc.readyState !== 'open') return;
    try {
        state.dc.send(encodeSyncReq(now()));
        logDebug('sync', 'sent ClockSyncReq');
    } catch (e) {
        logError('sync', `Send error: ${e.message}`);
    }
}

export function stopSending() {
    if (state.sendTimer) { clearInterval(state.sendTimer); state.sendTimer = null; }
}

// ── Main connect / disconnect ─────────────────────────────────────────────────

export async function connect() {
    if (state.sigWs) disconnect();

    logInfo('webrtc', `Connecting to signaling: ${CONFIG.signalUrl}`);
    state.sigWs = new WebSocket(CONFIG.signalUrl);
    state.sigWs.onclose = () => logInfo('signal', 'Signaling WebSocket closed');
    state.sigWs.onerror = (e) => logError('signal', 'Signaling WS error', e);

    await new Promise((resolve, reject) => {
        state.sigWs.onopen  = resolve;
        state.sigWs.onerror = reject;
    });
    logInfo('signal', 'Signaling connected — waiting for peer_ready…');

    state.pc = new RTCPeerConnection({ iceServers: CONFIG.iceServers });
    state.dc = state.pc.createDataChannel('teleop', { ordered: false, maxRetransmits: 0 });
    state.dc.binaryType = 'arraybuffer';

    // ── DataChannel events ────────────────────────────────────────────────────
    state.dc.onopen = async () => {
        logInfo('webrtc', 'DataChannel open — P2P established');
        setConnected(true);

        logInfo('sync', 'Initial clock sync (5 samples)…');
        for (let i = 0; i < 5; i++) { sendSyncReq(); await sleep(200); }

        if (state.clockSynced)
            logInfo('sync', `Synced: offset=${state.clockOffset.toFixed(1)}ms rtt=${state.clockRtt.toFixed(1)}ms`);
        else
            logWarn('sync', `Sync incomplete (${state.offsets.length}/3 samples). Continuing.`);

        state.syncInterval = setInterval(sendSyncReq, CONFIG.syncIntervalMs);
        if (handlers.onConnected) handlers.onConnected();
    };

    state.dc.onclose = () => {
        logInfo('webrtc', 'DataChannel closed');
        setConnected(false);
        stopSending();
        if (state.syncInterval) { clearInterval(state.syncInterval); state.syncInterval = null; }
        state.twistActive = false;
        setChartActive(false);
    };

    state.dc.onerror = (e) => logError('webrtc', 'DataChannel error', e);

    state.dc.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        const type = new Uint8Array(e.data)[0];
        if      (type === MSG_ACK       && handlers.onAck)      handlers.onAck(e.data);
        else if (type === MSG_SYNC_RESP && handlers.onSyncResp) handlers.onSyncResp(e.data);
        else logWarn('webrtc', `Unknown message type: 0x${type.toString(16)}`);
    };

    // ── ICE / connection state ────────────────────────────────────────────────
    state.pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        const c = e.candidate;
        sendSignal({ type: 'ice_candidate', candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex });
        logDebug('ice', 'Sent local ICE candidate');
    };

    state.pc.onconnectionstatechange = () => {
        logInfo('webrtc', `Connection state: ${state.pc.connectionState}`);
        if (state.pc.connectionState === 'failed') {
            logError('webrtc', 'WebRTC connection failed');
            setConnected(false);
        }
    };

    // ── Signaling message loop ────────────────────────────────────────────────
    state.sigWs.onmessage = async (e) => {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
            case 'welcome':
                state.myPeerId = msg.peer_id;
                logInfo('signal', `Peer ID: ${state.myPeerId}`);
                break;

            case 'peer_ready':
                if (msg.role === 'python') {
                    logInfo('signal', 'Python ready — sending SDP offer…');
                    await _createAndSendOffer();
                }
                break;

            case 'answer':
                logInfo('signal', 'Received SDP answer from Python');
                await state.pc.setRemoteDescription(
                    new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
                break;

            case 'ice_candidate':
                if (msg.candidate && state.pc) {
                    try {
                        await state.pc.addIceCandidate(new RTCIceCandidate({
                            candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex,
                        }));
                        logDebug('ice', 'Added remote ICE candidate');
                    } catch (err) {
                        logDebug('ice', `ICE add error (may be ok): ${err.message}`);
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
                logDebug('signal', `Unknown signal message: ${msg.type}`);
        }
    };
}

export function disconnect() {
    stopSending();
    if (state.syncInterval) { clearInterval(state.syncInterval); state.syncInterval = null; }
    try { state.dc?.close();    } catch (_) {}
    try { state.pc?.close();    } catch (_) {}
    try { state.sigWs?.close(); } catch (_) {}
    state.dc = null; state.pc = null; state.sigWs = null;
    state.offsets = []; state.clockSynced = false;
    state.twistActive = false;
    setConnected(false);
    setChartActive(false);
    logInfo('webrtc', 'Disconnected');
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function _createAndSendOffer() {
    if (!state.pc) return;
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    sendSignal({ type: 'offer', sdp: state.pc.localDescription.sdp });
    logInfo('signal', 'SDP offer sent');
}
