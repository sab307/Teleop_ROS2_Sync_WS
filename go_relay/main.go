package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

/*
BINARY PROTOCOL
===============

All messages use little-endian byte order.
First byte is message type:
  0x01 = Twist Command
  0x02 = Twist Ack
  0x03 = Clock Sync Request
  0x04 = Clock Sync Response

TWIST MESSAGE (variable size):
  [0]     uint8   type (0x01)
  [1-8]   uint64  message_id
  [9-16]  uint64  t1_browser_send
  [17]    uint8   field_mask (bitmask of included velocity fields)
  [18+]   float64 × popcount(field_mask) velocity values

  Field mask bits:
    bit 0 (0x01) = linear.x
    bit 1 (0x02) = linear.y
    bit 2 (0x04) = linear.z
    bit 3 (0x08) = angular.x
    bit 4 (0x10) = angular.y
    bit 5 (0x20) = angular.z

  Examples:
    linear.y + angular.z (0x22) = 18 + 16 = 34 bytes
    All 6 fields (0x3F)         = 18 + 48 = 66 bytes

  Relay appends t2 + t3 (16 bytes) at the end.

ENCODING IN GO
--------------
    binary.LittleEndian.PutUint64(buf[offset:], value)
    value := binary.LittleEndian.Uint64(buf[offset:])
*/

// Message type constants
const (
	MsgTypeTwist            = 0x01
	MsgTypeTwistAck         = 0x02
	MsgTypeClockSyncRequest = 0x03
	MsgTypeClockSyncResp    = 0x04

	TwistHeaderSize   = 18 // type + msg_id + t1 + field_mask
	TwistRelayAppend  = 16 // t2 + t3
	AckFromPythonSize = 69
	AckToBrowserSize  = 77
	ClockSyncReqSize  = 9
	ClockSyncRespSize = 25
)

// currentTimeMs returns milliseconds since Unix epoch
func currentTimeMs() uint64 {
	return uint64(time.Now().UnixMilli())
}

// Peer represents a WebSocket connection
type Peer struct {
	ID       string
	Type     string // "web" or "python"
	Conn     *websocket.Conn
	SendChan chan []byte
	mu       sync.Mutex
}

// PeerManager manages connected peers
type PeerManager struct {
	mu         sync.RWMutex
	peers      map[string]*Peer
	webPeers   map[string]*Peer
	pythonPeer *Peer
}

var manager = &PeerManager{
	peers:    make(map[string]*Peer),
	webPeers: make(map[string]*Peer),
}

var upgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
}

func newPeerID() string {
	return fmt.Sprintf("peer_%d", time.Now().UnixNano())
}

func (m *PeerManager) addPeer(p *Peer) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.peers[p.ID] = p
	if p.Type == "web" {
		m.webPeers[p.ID] = p
	} else if p.Type == "python" {
		m.pythonPeer = p
	}
	log.Printf("+ Peer %s (%s), total: %d", p.ID, p.Type, len(m.peers))
}

func (m *PeerManager) removePeer(p *Peer) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.peers, p.ID)
	delete(m.webPeers, p.ID)
	if m.pythonPeer != nil && m.pythonPeer.ID == p.ID {
		m.pythonPeer = nil
	}
	log.Printf("- Peer %s, total: %d", p.ID, len(m.peers))
}

func (m *PeerManager) getPython() *Peer {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.pythonPeer
}

func (m *PeerManager) getWebPeers() []*Peer {
	m.mu.RLock()
	defer m.mu.RUnlock()
	peers := make([]*Peer, 0, len(m.webPeers))
	for _, p := range m.webPeers {
		peers = append(peers, p)
	}
	return peers
}

// WebSocket handler
func handleWS(w http.ResponseWriter, r *http.Request) {
	peerType := r.URL.Query().Get("type")
	if peerType == "" {
		peerType = "web"
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade error: %v", err)
		return
	}

	peer := &Peer{
		ID:       newPeerID(),
		Type:     peerType,
		Conn:     conn,
		SendChan: make(chan []byte, 256),
	}
	manager.addPeer(peer)

	defer func() {
		manager.removePeer(peer)
		conn.Close()
	}()

	// Send welcome (JSON)
	welcome := map[string]interface{}{
		"type":    "welcome",
		"peer_id": peer.ID,
	}
	conn.WriteJSON(welcome)

	// Start writer goroutine
	go writeLoop(peer)

	// Read loop
	readLoop(peer)
}

func writeLoop(peer *Peer) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case msg, ok := <-peer.SendChan:
			if !ok {
				peer.Conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			peer.mu.Lock()
			err := peer.Conn.WriteMessage(websocket.BinaryMessage, msg)
			peer.mu.Unlock()
			if err != nil {
				return
			}

		case <-ticker.C:
			peer.mu.Lock()
			err := peer.Conn.WriteMessage(websocket.PingMessage, nil)
			peer.mu.Unlock()
			if err != nil {
				return
			}
		}
	}
}

func readLoop(peer *Peer) {
	peer.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	peer.Conn.SetPongHandler(func(string) error {
		peer.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		msgType, data, err := peer.Conn.ReadMessage()
		if err != nil {
			return
		}
		peer.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		if msgType == websocket.BinaryMessage {
			handleBinary(peer, data)
		}
	}
}

func handleBinary(peer *Peer, data []byte) {
	if len(data) < 1 {
		return
	}

	switch data[0] {
	case MsgTypeTwist:
		handleTwist(peer, data)
	case MsgTypeTwistAck:
		handleAck(peer, data)
	case MsgTypeClockSyncRequest:
		handleClockSync(peer, data)
	}
}

/*
handleTwist processes Twist from browser and forwards to Python.

Browser sends 65 bytes:
  [0]     type (0x01)
  [1-8]   message_id (uint64)
  [9-16]  t1_browser_send (uint64)
  [17-64] velocities (6 × float64)

Relay appends 16 bytes before forwarding (total 81 bytes):
  [65-72] t2_relay_rx (uint64)
  [73-80] t3_relay_tx (uint64)

BINARY ENCODING EXPLAINED:
--------------------------
binary.LittleEndian.PutUint64(buf[65:], t2)

This writes t2 as 8 bytes starting at offset 65:
  - Takes the uint64 value
  - Splits into 8 bytes, least significant first
  - Example: 0x0102030405060708 becomes [08, 07, 06, 05, 04, 03, 02, 01]
*/
// popcount returns the number of set bits in a byte
func popcount(b byte) int {
	count := 0
	for b != 0 {
		count += int(b & 1)
		b >>= 1
	}
	return count
}

func handleTwist(peer *Peer, data []byte) {
	t2 := currentTimeMs() // Relay receive time

	if len(data) < TwistHeaderSize {
		log.Printf("Invalid twist size: %d (min %d)", len(data), TwistHeaderSize)
		return
	}

	// Read field_mask at offset 17 to determine expected size
	fieldMask := data[17]
	numFields := popcount(fieldMask)
	expectedSize := TwistHeaderSize + numFields*8

	if len(data) < expectedSize {
		log.Printf("Twist too short: %d bytes (mask=0x%02x needs %d)", len(data), fieldMask, expectedSize)
		return
	}

	python := manager.getPython()
	if python == nil {
		log.Printf("No Python peer")
		return
	}

	// Create extended message: original + t2 + t3
	extendedSize := expectedSize + TwistRelayAppend
	extended := make([]byte, extendedSize)
	copy(extended, data[:expectedSize])

	// Append relay timestamps at end of message
	t3 := currentTimeMs()
	binary.LittleEndian.PutUint64(extended[expectedSize:], t2)
	binary.LittleEndian.PutUint64(extended[expectedSize+8:], t3)

	// Send to Python
	select {
	case python.SendChan <- extended:
		msgID := binary.LittleEndian.Uint64(data[1:9])
		log.Printf("→ Python: Twist #%d (%dB, mask=0x%02x, t2=%d, t3=%d)", msgID, extendedSize, fieldMask, t2, t3)
	default:
		log.Printf("Python send buffer full")
	}
}

/*
handleAck processes Ack from Python and forwards to browser.

Python sends 69 bytes:

	[0]     type (0x02)
	[1-8]   message_id
	[9-16]  t1_browser_send
	[17-24] t2_relay_rx
	[25-32] t3_relay_tx
	[33-40] t3_python_rx
	[41-48] t4_python_ack
	[49-52] python_decode_us (uint32)
	[53-56] python_process_us (uint32)
	[57-60] python_encode_us (uint32)
	[61-68] reserved (for t4_relay_ack_rx)

Relay fills reserved field and appends t5 (total 77 bytes):

	[61-68] t4_relay_ack_rx (relay fills this)
	[69-76] t5_relay_ack_tx (relay appends)
*/
func handleAck(peer *Peer, data []byte) {
	t4 := currentTimeMs() // Relay ack receive time

	if peer.Type != "python" {
		return
	}

	if len(data) < AckFromPythonSize {
		log.Printf("Invalid ack size: %d bytes (expected %d)", len(data), AckFromPythonSize)
		return
	}

	// Create extended ack for browser
	extended := make([]byte, AckToBrowserSize)
	copy(extended, data[:AckFromPythonSize])

	// Fill t4_relay_ack_rx at offset 61 and append t5 at offset 69
	t5 := currentTimeMs()
	binary.LittleEndian.PutUint64(extended[61:69], t4)
	binary.LittleEndian.PutUint64(extended[69:77], t5)

	// Forward to all web peers
	webPeers := manager.getWebPeers()
	for _, web := range webPeers {
		select {
		case web.SendChan <- extended:
		default:
		}
	}

	msgID := binary.LittleEndian.Uint64(data[1:9])
	log.Printf("← Browser: Ack #%d to %d peers (t4=%d, t5=%d)", msgID, len(webPeers), t4, t5)
}

/*
handleClockSync responds to clock sync requests.

Request (9 bytes):

	[0]   type (0x03)
	[1-8] t1 (client send time)

Response (25 bytes):

	[0]    type (0x04)
	[1-8]  t1 (echoed)
	[9-16] t2 (server receive time)
	[17-24] t3 (server send time)

NTP-STYLE OFFSET CALCULATION (done by client):

	RTT = (t4 - t1) - (t3 - t2)
	Offset = ((t2 - t1) + (t3 - t4)) / 2
*/
func handleClockSync(peer *Peer, data []byte) {
	t2 := currentTimeMs()

	if len(data) < ClockSyncReqSize {
		return
	}

	t1 := binary.LittleEndian.Uint64(data[1:9])
	t3 := currentTimeMs()

	resp := make([]byte, ClockSyncRespSize)
	resp[0] = MsgTypeClockSyncResp
	binary.LittleEndian.PutUint64(resp[1:], t1)
	binary.LittleEndian.PutUint64(resp[9:], t2)
	binary.LittleEndian.PutUint64(resp[17:], t3)

	select {
	case peer.SendChan <- resp:
		log.Printf("Clock sync: t1=%d t2=%d t3=%d", t1, t2, t3)
	default:
	}
}

// HTTP handlers
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "ok",
		"time":   currentTimeMs(),
	})
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	manager.mu.RLock()
	defer manager.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"total_peers":      len(manager.peers),
		"web_peers":        len(manager.webPeers),
		"python_connected": manager.pythonPeer != nil,
	})
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == "OPTIONS" {
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/data", handleWS)
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/status", handleStatus)
	mux.Handle("/", http.FileServer(http.Dir("../web-client")))

	fmt.Println()
	fmt.Println("Binary Message Sizes:")
	fmt.Println("  0x01 Twist:    65B (browser) → 81B (to Python)")
	fmt.Println("  0x02 Ack:      69B (Python)  → 77B (to browser)")
	fmt.Println("  0x03 SyncReq:   9B")
	fmt.Println("  0x04 SyncResp: 25B")
	fmt.Println()
	fmt.Printf("Listening on :%s\n", port)
	fmt.Println("  WS  /ws/data  - Binary data")
	fmt.Println("  GET /         - Web client")

	log.Fatal(http.ListenAndServe(":"+port, corsMiddleware(mux)))
}
