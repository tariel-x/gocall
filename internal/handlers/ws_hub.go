package handlers

import (
	"log/slog"
	"sync"

	"github.com/gorilla/websocket"
)

type wsClientV2 struct {
	conn      *websocket.Conn
	send      chan []byte
	callID    string
	peerID    string
	closeOnce sync.Once
}

func (c *wsClientV2) trySend(payload []byte) (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	select {
	case c.send <- payload:
		return true
	default:
		return false
	}
}

func (c *wsClientV2) closeSend() {
	c.closeOnce.Do(func() {
		close(c.send)
	})
}

type WSHubV2 struct {
	mu    sync.Mutex
	calls map[string]map[string]*wsClientV2 // callID -> peerID -> client
}

func NewWSHubV2() *WSHubV2 {
	return &WSHubV2{
		calls: make(map[string]map[string]*wsClientV2),
	}
}

func (h *WSHubV2) Add(client *wsClientV2) {
	h.mu.Lock()
	defer h.mu.Unlock()

	peers, ok := h.calls[client.callID]
	if !ok {
		peers = make(map[string]*wsClientV2)
		h.calls[client.callID] = peers
	}

	// Replace existing connection for the same peer_id.
	if old := peers[client.peerID]; old != nil {
		_ = old.conn.Close()
		old.closeSend()
	}

	peers[client.peerID] = client
	slog.Default().Debug("ws hub add", "call_id", client.callID, "peer_id", client.peerID)
}

func (h *WSHubV2) Remove(callID, peerID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	slog.Default().Debug("ws hub remove", "call_id", callID, "peer_id", peerID)

	peers, ok := h.calls[callID]
	if !ok {
		return
	}

	if client, exists := peers[peerID]; exists {
		client.closeSend()
	}
	delete(peers, peerID)
	if len(peers) == 0 {
		delete(h.calls, callID)
	}
}

func (h *WSHubV2) SendTo(callID, peerID string, payload []byte) bool {
	h.mu.Lock()
	client := func() *wsClientV2 {
		peers := h.calls[callID]
		return peers[peerID]
	}()
	if client == nil {
		h.mu.Unlock()
		return false
	}
	h.mu.Unlock()

	if !client.trySend(payload) {
		slog.Default().Debug("ws hub send direct blocked", "call_id", callID, "to_peer_id", peerID)
		_ = client.conn.Close()
		return false
	}
	return true
}

func (h *WSHubV2) SendToOther(callID, fromPeerID string, payload []byte) bool {
	h.mu.Lock()
	var other *wsClientV2
	if peers, ok := h.calls[callID]; ok {
		for peerID, client := range peers {
			if peerID == fromPeerID {
				continue
			}
			other = client
			break
		}
	}
	if other == nil {
		h.mu.Unlock()
		return false
	}
	h.mu.Unlock()

	if !other.trySend(payload) {
		slog.Default().Debug("ws hub send other blocked", "call_id", callID, "from_peer_id", fromPeerID, "to_peer_id", other.peerID)
		_ = other.conn.Close()
		return false
	}
	return true
}

func (h *WSHubV2) Broadcast(callID string, payload []byte) {
	h.mu.Lock()
	var clients []*wsClientV2
	if peers, ok := h.calls[callID]; ok {
		clients = make([]*wsClientV2, 0, len(peers))
		for _, client := range peers {
			clients = append(clients, client)
		}
	}
	h.mu.Unlock()

	for _, client := range clients {
		if !client.trySend(payload) {
			_ = client.conn.Close()
		}
	}
}

func (h *WSHubV2) CloseCall(callID string) {
	h.mu.Lock()
	peers, ok := h.calls[callID]
	if !ok {
		h.mu.Unlock()
		return
	}
	delete(h.calls, callID)
	h.mu.Unlock()

	for _, client := range peers {
		_ = client.conn.Close()
		client.closeSend()
	}
}
