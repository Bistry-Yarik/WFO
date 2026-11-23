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
	Token string   `json:"token"`
	URLs  []string `json:"urls"`
}

type roomMessage struct {
	Kind   string          `json:"kind"`
	ID     string          `json:"id,omitempty"`
	Packet json.RawMessage `json:"packet,omitempty"`
}

type roomSocket struct {
	conn  *websocket.Conn
	write sync.Mutex
}

func (s *roomSocket) send(message roomMessage) error {
	s.write.Lock()
	defer s.write.Unlock()
	s.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return s.conn.WriteJSON(message)
}

type localRoom struct {
	code, token string
	server      *http.Server
	mu          sync.Mutex
	host        *roomSocket
	guests      map[string]*roomSocket
}

func newLocalRoom(code string, game []byte) (*localRoom, roomAddress, error) {
	if !roomCodePattern.MatchString(code) {
		return nil, roomAddress{}, errors.New("Нужны 10 английских букв или точек")
	}
	var secret [24]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return nil, roomAddress{}, err
	}
	listener, err := net.Listen("tcp4", fmt.Sprintf(":%d", roomPort))
	if err != nil {
		return nil, roomAddress{}, fmt.Errorf("Не удалось открыть порт %d: %w", roomPort, err)
	}
	room := &localRoom{code: code, token: hex.EncodeToString(secret[:]), guests: make(map[string]*roomSocket)}
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
	return room, roomAddress{Token: room.token, URLs: roomURLs(code)}, nil
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
	room.server.Close()
	room.mu.Lock()
	defer room.mu.Unlock()
	if room.host != nil {
		room.host.conn.Close()
	}
	for _, guest := range room.guests {
		guest.conn.Close()
	}
}

func (room *localRoom) connect(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	hosting := query.Get("host") == room.token
	if !hosting && query.Get("code") != room.code {
		http.Error(w, "Room code mismatch", http.StatusForbidden)
		return
	}
	if hosting {
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		if !net.ParseIP(ip).IsLoopback() {
			http.Error(w, "Host must be local", http.StatusForbidden)
			return
		}
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
	conn.SetReadLimit(16 * 1024 * 1024)
	socket := &roomSocket{conn: conn}

	room.mu.Lock()
	if hosting {
		if room.host != nil {
			room.mu.Unlock()
			return
		}
		room.host = socket
		room.mu.Unlock()
		defer room.disconnectHost(socket)
		for {
			var message roomMessage
			if conn.ReadJSON(&message) != nil {
				return
			}
			if message.Kind != "packet" {
				continue
			}
			room.mu.Lock()
			guest := room.guests[message.ID]
			room.mu.Unlock()
			if guest != nil && guest.send(message) != nil {
				guest.conn.Close()
			}
		}
	}

	var idBytes [12]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		room.mu.Unlock()
		return
	}
	id := hex.EncodeToString(idBytes[:])
	host := room.host
	if host == nil || len(room.guests) >= 16 {
		room.mu.Unlock()
		return
	}
	room.guests[id] = socket
	room.mu.Unlock()
	defer func() {
		room.mu.Lock()
		delete(room.guests, id)
		room.mu.Unlock()
		_ = host.send(roomMessage{Kind: "gone", ID: id})
	}()
	if host.send(roomMessage{Kind: "joined", ID: id}) != nil {
		return
	}
	for {
		var message roomMessage
		if conn.ReadJSON(&message) != nil {
			return
		}
		if message.Kind != "packet" {
			continue
		}
		message.ID = id
		if host.send(message) != nil {
			return
		}
	}
}

func (room *localRoom) disconnectHost(socket *roomSocket) {
	room.mu.Lock()
	defer room.mu.Unlock()
	if room.host != socket {
		return
	}
	room.host = nil
	for _, guest := range room.guests {
		guest.conn.Close()
	}
}
