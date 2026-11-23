package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const roomPort = 8765

var roomCodePattern = regexp.MustCompile(`^[a-z.]{10}$`)

type roomAddress struct {
	URLs []string `json:"urls"`
}

type roomMessage struct {
	Kind   string          `json:"kind"`
	ID     string          `json:"id,omitempty"`
	Packet json.RawMessage `json:"packet,omitempty"`
}

type roomSocket struct {
	conn     *websocket.Conn
	outgoing chan roomMessage
	done     chan struct{}
}

type localRoom struct {
	code   string
	server *http.Server
	mu     sync.Mutex
	guests map[string]*roomSocket
	events chan roomMessage
	done   chan struct{}
}

func newLocalRoom(code string, game []byte) (*localRoom, roomAddress, error) {
	if !roomCodePattern.MatchString(code) {
		return nil, roomAddress{}, errors.New("Нужны 10 английских букв или точек")
	}
	listener, err := net.Listen("tcp4", fmt.Sprintf(":%d", roomPort))
	if err != nil {
		return nil, roomAddress{}, fmt.Errorf("Не удалось открыть порт %d: %w", roomPort, err)
	}
	room := &localRoom{
		code: code, guests: make(map[string]*roomSocket),
		events: make(chan roomMessage, 64), done: make(chan struct{}),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/room", room.connect)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(game)
	})
	room.server = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go room.server.Serve(listener)
	return room, roomAddress{URLs: roomURLs(code)}, nil
}

func roomURLs(code string) []string {
	var addresses []string
	interfaces, _ := net.Interfaces()
	for _, adapter := range interfaces {
		if adapter.Flags&net.FlagUp == 0 || adapter.Flags&net.FlagLoopback != 0 {
			continue
		}
		ips, _ := adapter.Addrs()
		for _, addr := range ips {
			ip, _, err := net.ParseCIDR(addr.String())
			if err == nil && ip.To4() != nil && !ip.IsLinkLocalUnicast() {
				addresses = append(addresses, fmt.Sprintf("http://%s:%d/?room=%s", ip.String(), roomPort, code))
			}
		}
	}
	return addresses
}

func (room *localRoom) close() {
	close(room.done)
	room.server.Close()
	room.mu.Lock()
	defer room.mu.Unlock()
	for _, guest := range room.guests {
		guest.conn.Close()
	}
}

func (room *localRoom) poll() []roomMessage {
	events := make([]roomMessage, 0)
	for len(events) < 32 {
		select {
		case message := <-room.events:
			events = append(events, message)
		default:
			return events
		}
	}
	return events
}

func (room *localRoom) send(id string, packet json.RawMessage) bool {
	room.mu.Lock()
	guest := room.guests[id]
	room.mu.Unlock()
	if guest == nil {
		return true
	}
	select {
	case guest.outgoing <- roomMessage{Kind: "packet", ID: id, Packet: packet}:
		return true
	default:
		return false
	}
}

func (room *localRoom) enqueue(message roomMessage) bool {
	select {
	case room.events <- message:
		return true
	case <-room.done:
		return false
	}
}

func (room *localRoom) connect(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("code") != room.code {
		http.Error(w, "Room code mismatch", http.StatusForbidden)
		return
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(req *http.Request) bool {
		origin := req.Header.Get("Origin")
		if origin == "" || origin == "null" {
			return true
		}
		parsed, err := url.Parse(origin)
		return err == nil && parsed.Host == req.Host
	}}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(128 * 1024)
	socket := &roomSocket{conn: conn, outgoing: make(chan roomMessage, 8), done: make(chan struct{})}
	var idBytes [12]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		return
	}
	id := hex.EncodeToString(idBytes[:])
	room.mu.Lock()
	if len(room.guests) >= 16 {
		room.mu.Unlock()
		return
	}
	room.guests[id] = socket
	room.mu.Unlock()
	defer func() {
		close(socket.done)
		room.mu.Lock()
		delete(room.guests, id)
		room.mu.Unlock()
		room.enqueue(roomMessage{Kind: "gone", ID: id})
	}()
	if !room.enqueue(roomMessage{Kind: "joined", ID: id}) {
		return
	}
	go socket.writeMessages()
	for {
		var message roomMessage
		if conn.ReadJSON(&message) != nil {
			return
		}
		if message.Kind != "packet" {
			continue
		}
		message.ID = id
		if !room.enqueue(message) {
			return
		}
	}
}

func (s *roomSocket) writeMessages() {
	for {
		select {
		case <-s.done:
			return
		case message := <-s.outgoing:
			s.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if s.conn.WriteJSON(message) != nil {
				s.conn.Close()
				return
			}
		}
	}
}
