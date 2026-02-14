package handlers

import (
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
}

func (h *WSHubV2) Remove(callID, peerID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

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
	h.mu.Unlock()

	if client == nil {
		return false
	}

	select {
	case client.send <- payload:
		return true
	default:
		_ = client.conn.Close()
		return false
	}
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
	h.mu.Unlock()

	if other == nil {
		return false
	}

	select {
	case other.send <- payload:
		return true
	default:
		_ = other.conn.Close()
		return false
	}
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
		select {
		case client.send <- payload:
		default:
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
