package main

/*
WebRTC Signaling Server
=======================

ROLE: This server handles ONLY the WebRTC handshake (SDP + ICE exchange).
Once the RTCPeerConnection is established and the DataChannel opens,
all binary robot-control data (Twist, Ack, ClockSync) flows directly
between the browser and the Python process — the Go server is no longer
in the data path.

SIGNALING FLOW:
  1. Python  connects → /ws/signal?role=python
  2. Browser connects → /ws/signal?role=browser
  3. Go sends "peer_ready" to each side when both are present
  4. Browser creates RTCPeerConnection + DataChannel, generates SDP offer
  5. Browser sends {"type":"offer","sdp":"..."} through Go to Python
  6. Python (aiortc) sets remote desc, creates SDP answer
  7. Python sends {"type":"answer","sdp":"...","to_peer":"<browser_id>"} to Go
  8. Go routes answer to the correct browser
  9. Both sides exchange ICE candidates through Go
 10. DataChannel opens → P2P established, Go steps aside

MESSAGE ENVELOPE (all JSON):
  From Browser:
    {"type":"offer",         "sdp":"..."}
    {"type":"ice_candidate", "candidate":"...", "sdpMid":"...", "sdpMLineIndex":0}

  From Python:
    {"type":"answer",        "sdp":"...", "to_peer":"<browser_id>"}
    {"type":"ice_candidate", "candidate":"...", "sdpMid":"...", "sdpMLineIndex":0, "to_peer":"<browser_id>"}

  To Browser:
    {"type":"welcome",          "peer_id":"<id>"}
    {"type":"peer_ready",       "role":"python"}
    {"type":"answer",           "sdp":"..."}
    {"type":"ice_candidate",    "candidate":"...", "sdpMid":"...", "sdpMLineIndex":0}
    {"type":"peer_disconnected","role":"python"}

  To Python:
    {"type":"welcome",          "peer_id":"<id>"}
    {"type":"peer_ready",       "role":"browser", "from_peer":"<browser_id>"}
    {"type":"offer",            "sdp":"...", "from_peer":"<browser_id>"}
    {"type":"ice_candidate",    "candidate":"...", "sdpMid":"...", "sdpMLineIndex":0, "from_peer":"<browser_id>"}
    {"type":"peer_disconnected","role":"browser",  "from_peer":"<browser_id>"}
*/

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ─── Signal message ───────────────────────────────────────────────────────────

// SignalMsg is the JSON envelope for all signaling messages.
type SignalMsg struct {
	Type          string `json:"type"`
	SDP           string `json:"sdp,omitempty"`
	Candidate     string `json:"candidate,omitempty"`
	SdpMid        string `json:"sdpMid,omitempty"`
	SdpMLineIndex *int   `json:"sdpMLineIndex,omitempty"`
	Role          string `json:"role,omitempty"`
	PeerID        string `json:"peer_id,omitempty"`   // used in "welcome"
	FromPeer      string `json:"from_peer,omitempty"` // routing: sender id
	ToPeer        string `json:"to_peer,omitempty"`   // routing: recipient id
}

// ─── Peer ─────────────────────────────────────────────────────────────────────

type Peer struct {
	id   string
	role string // "browser" | "python"
	conn *websocket.Conn
	send chan []byte
	mu   sync.Mutex
	hub  *Hub
}

func newPeerID(role string) string {
	return fmt.Sprintf("%s_%d", role, time.Now().UnixNano())
}

func (p *Peer) sendMsg(msg SignalMsg) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("[signal] marshal error: %v", err)
		return
	}
	select {
	case p.send <- data:
	default:
		log.Printf("[signal] %s send buffer full — dropping", p.id)
	}
}

// writeLoop drains send channel; sends WebSocket pings to keep alive.
func (p *Peer) writeLoop() {
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case msg, ok := <-p.send:
			if !ok {
				p.mu.Lock()
				_ = p.conn.WriteMessage(websocket.CloseMessage, nil)
				p.mu.Unlock()
				return
			}
			p.mu.Lock()
			err := p.conn.WriteMessage(websocket.TextMessage, msg)
			p.mu.Unlock()
			if err != nil {
				return
			}

		case <-ticker.C:
			p.mu.Lock()
			err := p.conn.WriteMessage(websocket.PingMessage, nil)
			p.mu.Unlock()
			if err != nil {
				return
			}
		}
	}
}

// readLoop reads JSON signaling messages and dispatches them.
func (p *Peer) readLoop() {
	p.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	p.conn.SetPongHandler(func(string) error {
		p.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, data, err := p.conn.ReadMessage()
		if err != nil {
			return
		}
		p.conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		var msg SignalMsg
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("[signal] %s bad JSON: %v", p.id, err)
			continue
		}

		p.hub.dispatch(p, msg)
	}
}

// ─── Hub ──────────────────────────────────────────────────────────────────────

// Hub tracks peers and routes signaling messages.
type Hub struct {
	mu       sync.RWMutex
	python   *Peer
	browsers map[string]*Peer
}

var hub = &Hub{
	browsers: make(map[string]*Peer),
}

func (h *Hub) add(p *Peer) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if p.role == "python" {
		if h.python != nil {
			log.Printf("[signal] Python reconnect — closing old %s", h.python.id)
			close(h.python.send)
		}
		h.python = p
		log.Printf("[signal] + python  %s  (browsers: %d)", p.id, len(h.browsers))
		// Notify existing browsers
		for _, b := range h.browsers {
			b.sendMsg(SignalMsg{Type: "peer_ready", Role: "python"})
		}
	} else {
		h.browsers[p.id] = p
		log.Printf("[signal] + browser %s  (total: %d)", p.id, len(h.browsers))
		// Tell browser if Python is already connected
		if h.python != nil {
			p.sendMsg(SignalMsg{Type: "peer_ready", Role: "python"})
			// Tell Python about the new browser
			h.python.sendMsg(SignalMsg{Type: "peer_ready", Role: "browser", FromPeer: p.id})
		}
	}
}

func (h *Hub) remove(p *Peer) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if p.role == "python" {
		if h.python != nil && h.python.id == p.id {
			h.python = nil
		}
		log.Printf("[signal] - python  %s", p.id)
		for _, b := range h.browsers {
			b.sendMsg(SignalMsg{Type: "peer_disconnected", Role: "python"})
		}
	} else {
		delete(h.browsers, p.id)
		log.Printf("[signal] - browser %s  (remaining: %d)", p.id, len(h.browsers))
		if h.python != nil {
			h.python.sendMsg(SignalMsg{Type: "peer_disconnected", Role: "browser", FromPeer: p.id})
		}
	}
}

// dispatch routes a signaling message from src to the appropriate target.
func (h *Hub) dispatch(src *Peer, msg SignalMsg) {
	h.mu.RLock()
	py := h.python
	h.mu.RUnlock()

	switch msg.Type {
	case "offer":
		// Browser → Python
		if py == nil {
			log.Printf("[signal] offer from %s — no Python connected", src.id)
			return
		}
		msg.FromPeer = src.id
		py.sendMsg(msg)
		log.Printf("[signal] offer %s → python", src.id)

	case "answer":
		// Python → specific browser
		h.mu.RLock()
		browser := h.browsers[msg.ToPeer]
		h.mu.RUnlock()
		if browser == nil {
			log.Printf("[signal] answer — browser %q not found", msg.ToPeer)
			return
		}
		targetID := msg.ToPeer
		msg.ToPeer = "" // strip routing before forwarding
		browser.sendMsg(msg)
		log.Printf("[signal] answer python → %s", targetID)

	case "ice_candidate":
		if src.role == "browser" {
			// Browser ICE → Python
			if py == nil {
				return
			}
			msg.FromPeer = src.id
			py.sendMsg(msg)
		} else {
			// Python ICE → specific browser
			h.mu.RLock()
			browser := h.browsers[msg.ToPeer]
			h.mu.RUnlock()
			if browser == nil {
				return
			}
			msg.ToPeer = ""
			browser.sendMsg(msg)
		}

	default:
		log.Printf("[signal] unknown type %q from %s", msg.Type, src.id)
	}
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

var upgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
}

func handleSignal(w http.ResponseWriter, r *http.Request) {
	role := r.URL.Query().Get("role")
	if role != "python" {
		role = "browser"
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[signal] upgrade error: %v", err)
		return
	}

	peer := &Peer{
		id:   newPeerID(role),
		role: role,
		conn: conn,
		send: make(chan []byte, 64),
		hub:  hub,
	}

	hub.add(peer)
	defer func() {
		hub.remove(peer)
		conn.Close()
	}()

	// Send welcome first so client knows its ID
	peer.sendMsg(SignalMsg{Type: "welcome", PeerID: peer.id, Role: role})

	go peer.writeLoop()
	peer.readLoop() // blocks until disconnect
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	hub.mu.RLock()
	pythonOK := hub.python != nil
	browsers := len(hub.browsers)
	hub.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":           "ok",
		"time_ms":          time.Now().UnixMilli(),
		"python_connected": pythonOK,
		"browser_count":    browsers,
	})
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	hub.mu.RLock()
	defer hub.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"mode":             "webrtc_signaling",
		"python_connected": hub.python != nil,
		"browser_count":    len(hub.browsers),
	})
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ─── Main ────────────────────────────────────────────────────────────────────
//
// Flags take priority; env vars are used as fallbacks when a flag is omitted.
//
// Examples:
//   # Plain HTTP (development)
//   go run . --port 8080
//
//   # HTTPS / WSS with self-signed cert
//   go run . --port 8443 --tls-cert certs/cert.pem --tls-key certs/key.pem
//
//   # Or equivalently via env vars
//   TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem PORT=8443 ./go_relay
//
//   # Custom HTTP-redirect port (only relevant when TLS is active)
//   go run . --port 8443 --http-port 8080 --tls-cert certs/cert.pem --tls-key certs/key.pem

func main() {
	// ── Flag definitions (env-var fallbacks shown in usage strings) ───────────
	fPort := flag.String("port", envOr("PORT", "8443"), "HTTPS/WSS listen port (env: PORT)")
	fHTTPPort := flag.String("http-port", envOr("HTTP_PORT", "8080"), "HTTP→HTTPS redirect port, TLS only (env: HTTP_PORT)")
	fCert := flag.String("tls-cert", envOr("TLS_CERT", ""), "Path to TLS certificate PEM (env: TLS_CERT)")
	fKey := flag.String("tls-key", envOr("TLS_KEY", ""), "Path to TLS private key PEM (env: TLS_KEY)")
	fWebRoot := flag.String("web-root", "../web-client", "Directory to serve as the web root")
	flag.Parse()

	port := *fPort
	httpPort := *fHTTPPort
	certFile := *fCert
	keyFile := *fKey

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/signal", handleSignal)
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/status", handleStatus)
	mux.Handle("/", http.FileServer(http.Dir(*fWebRoot)))

	handler := corsMiddleware(mux)

	fmt.Println()
	if certFile != "" && keyFile != "" {
		// ── HTTPS / WSS mode ─────────────────────────────────────────────────
		fmt.Printf("  Mode      : HTTPS / WSS (TLS enabled)\n")
		fmt.Printf("  HTTPS     : https://localhost:%s\n", port)
		fmt.Printf("  WSS       : wss://localhost:%s/ws/signal\n", port)
		fmt.Printf("  Cert      : %s\n", certFile)
		fmt.Printf("  Key       : %s\n", keyFile)
		fmt.Printf("  Web root  : %s\n", *fWebRoot)
		fmt.Println()
		fmt.Println("  WSS  /ws/signal?role=python   Python peer")
		fmt.Println("  WSS  /ws/signal?role=browser  Browser peer")
		fmt.Println("  GET  /health                  Health check")
		fmt.Println("  GET  /status                  Status JSON")
		fmt.Println()

		// HTTP → HTTPS redirect goroutine
		go func() {
			redirect := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				host := r.Host
				if h, _, err := net.SplitHostPort(host); err == nil {
					host = h
				}
				target := "https://" + host
				if port != "443" {
					target += ":" + port
				}
				target += r.URL.RequestURI()
				http.Redirect(w, r, target, http.StatusMovedPermanently)
			})
			fmt.Printf("  HTTP redirect  :%s → HTTPS :%s\n\n", httpPort, port)
			if err := http.ListenAndServe(":"+httpPort, redirect); err != nil {
				log.Printf("HTTP redirect listener error: %v", err)
			}
		}()

		log.Fatal(http.ListenAndServeTLS(":"+port, certFile, keyFile, handler))

	} else {
		// ── HTTP / WS mode (no TLS) ───────────────────────────────────────────
		fmt.Printf("  Mode      : HTTP / WS  (no TLS — development only)\n")
		fmt.Printf("  HTTP      : http://localhost:%s\n", port)
		fmt.Printf("  WS        : ws://localhost:%s/ws/signal\n", port)
		fmt.Printf("  Web root  : %s\n", *fWebRoot)
		fmt.Println()
		fmt.Println("  WS   /ws/signal?role=python   Python peer")
		fmt.Println("  WS   /ws/signal?role=browser  Browser peer")
		fmt.Println("  GET  /health                  Health check")
		fmt.Println("  GET  /status                  Status JSON")
		fmt.Println()
		fmt.Println("  Tip: add --tls-cert and --tls-key to enable HTTPS/WSS")
		fmt.Println()

		log.Fatal(http.ListenAndServe(":"+port, handler))
	}
}

// envOr returns the value of the environment variable key, or fallback if unset.
func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
