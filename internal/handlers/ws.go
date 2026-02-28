package handlers

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/tariel-x/gocall/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

const (
	wsWriteWait       = 10 * time.Second
	wsPongWait        = 70 * time.Second
	wsPingPeriod      = 30 * time.Second
	wsHeartbeatPeriod = 5 * time.Second
)

type wsEnvelopeV2 struct {
	Type     string          `json:"type"`
	To       string          `json:"to,omitempty"`
	From     string          `json:"from,omitempty"`
	CallType string          `json:"call_type,omitempty"`
	Data     json.RawMessage `json:"data,omitempty"`
}

type wsJoinDataV2 struct {
	PeerID      string     `json:"peer_id"`
	Role        PeerRoleV2 `json:"role"`
	IsReconnect bool       `json:"is_reconnect"`
	PeerOnline  bool       `json:"peer_online"`
}

type wsStateDataV2 struct {
	CallID       string              `json:"call_id"`
	Status       models.CallStatusV2 `json:"status"`
	Participants callParticipants    `json:"participants"`
}

func (h *Handlers) HandleWebSocket(c *gin.Context) {
	callID := c.Query("call_id")
	peerID := c.Query("peer_id")
	if callID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "call_id is required"})
		return
	}
	slog.Default().Debug("ws connect request", "call_id", callID, "peer_id", peerID, "ip", c.ClientIP())

	now := h.nowFn()

	var role PeerRoleV2
	var call *models.CallV2
	reconnected := false
	if peerID == "" {
		var err error
		peerID, call, err = h.calls.EnsureHostPeerID(callID, now)
		if err != nil {
			h.writeWSCallError(c, err)
			return
		}
		role = PeerRoleV2Host
	} else {
		var err error
		role, call, reconnected, err = h.calls.ValidatePeer(callID, peerID, now)
		if err != nil {
			if err.Error() == "invalid peer_id" {
				c.JSON(http.StatusForbidden, gin.H{"error": "invalid peer_id"})
				return
			}
			h.writeWSCallError(c, err)
			return
		}
	}
	slog.Default().Debug("ws resolved peer", "call_id", callID, "peer_id", peerID, "role", role, "reconnected", reconnected)

	conn, err := h.wsUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		slog.Default().Warn("ws upgrade failed", "call_id", callID, "peer_id", peerID, "error", err)
		return
	}

	client := &wsClientV2{
		conn:   conn,
		send:   make(chan []byte, 32),
		callID: callID,
		peerID: peerID,
	}

	h.wsHub.Add(client)
	slog.Default().Debug("ws connected", "call_id", callID, "peer_id", peerID, "role", role)

	// Initial join ack to the client.
	joinMsg, _ := json.Marshal(wsEnvelopeV2{
		Type: "join",
		Data: mustMarshal(wsJoinDataV2{
			PeerID:      peerID,
			Role:        role,
			IsReconnect: reconnected,
			PeerOnline:  otherPeerOnline(call, peerID),
		}),
	})
	if !client.trySend(joinMsg) {
		slog.Default().Debug("ws send join failed", "call_id", callID, "peer_id", peerID)
		_ = client.conn.Close()
		return
	}
	slog.Default().Debug("ws sent join", "call_id", callID, "peer_id", peerID, "role", role, "peer_online", otherPeerOnline(call, peerID))

	if reconnected {
		reconnectMsg, _ := json.Marshal(wsEnvelopeV2{Type: "peer-reconnected", From: peerID})
		if ok := h.wsHub.SendToOther(callID, peerID, reconnectMsg); !ok {
			slog.Default().Debug("ws peer-reconnected not delivered", "call_id", callID, "from_peer_id", peerID)
		}
	}

	h.broadcastState(call)
	slog.Default().Debug("ws broadcast state", "call_id", callID, "peer_id", peerID)

	stopHeartbeat := make(chan struct{})
	go h.writePump(client)
	go h.heartbeatState(client, stopHeartbeat)
	h.readPump(client)
	close(stopHeartbeat)
}

func (h *Handlers) readPump(client *wsClientV2) {
	defer func() {
		slog.Default().Debug("ws disconnect", "call_id", client.callID, "peer_id", client.peerID)
		_ = client.conn.Close()
		h.calls.MarkPeerDisconnected(client.callID, client.peerID, h.nowFn())
		h.wsHub.Remove(client.callID, client.peerID)

		// Do not end the call on disconnect.
		// Clients may navigate between SPA screens and reconnect.
		disconnectMsg, _ := json.Marshal(wsEnvelopeV2{Type: "peer-disconnected", From: client.peerID})
		if ok := h.wsHub.SendToOther(client.callID, client.peerID, disconnectMsg); !ok {
			slog.Default().Debug("ws peer-disconnected not delivered", "call_id", client.callID, "from_peer_id", client.peerID)
		}
	}()

	_ = client.conn.SetReadDeadline(time.Now().Add(wsPongWait))
	client.conn.SetPongHandler(func(string) error {
		_ = client.conn.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})

	for {
		_, payload, err := client.conn.ReadMessage()
		if err != nil {
			slog.Default().Debug("ws read error", "call_id", client.callID, "peer_id", client.peerID, "error", err)
			return
		}

		var msg wsEnvelopeV2
		if err := json.Unmarshal(payload, &msg); err != nil {
			slog.Default().Debug("ws bad json", "call_id", client.callID, "peer_id", client.peerID, "error", err)
			continue
		}

		if msg.Type == "ping" {
			continue
		}

		// Avoid logging full SDP/candidate payloads (may contain IPs). Log sizes/type only.
		slog.Default().Debug("ws recv", "call_id", client.callID, "peer_id", client.peerID, "type", msg.Type, "to", msg.To, "data_bytes", len(msg.Data))

		msg.From = client.peerID
		forward, err := json.Marshal(msg)
		if err != nil {
			continue
		}

		if msg.To != "" {
			if ok := h.wsHub.SendTo(client.callID, msg.To, forward); !ok {
				slog.Default().Debug("ws forward direct not delivered", "call_id", client.callID, "from_peer_id", client.peerID, "to_peer_id", msg.To, "type", msg.Type)
			}
			continue
		}

		// If 'to' is omitted, route to the other participant.
		if ok := h.wsHub.SendToOther(client.callID, client.peerID, forward); !ok {
			slog.Default().Debug("ws forward other not delivered", "call_id", client.callID, "from_peer_id", client.peerID, "type", msg.Type)
		}
	}
}

func (h *Handlers) writePump(client *wsClientV2) {
	defer func() {
		_ = client.conn.Close()
	}()

	ticker := time.NewTicker(wsPingPeriod)
	defer ticker.Stop()

	for {
		select {
		case msg, ok := <-client.send:
			if !ok {
				return
			}
			_ = client.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if err := client.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = client.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if err := client.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (h *Handlers) broadcastState(call *models.CallV2) {
	msg := stateMessage(call)
	if len(msg) == 0 {
		return
	}
	h.wsHub.Broadcast(call.ID, msg)
}

func (h *Handlers) heartbeatState(client *wsClientV2, stop <-chan struct{}) {
	ticker := time.NewTicker(wsHeartbeatPeriod)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			call, err := h.calls.GetByID(client.callID, h.nowFn())
			if err != nil {
				if errors.Is(err, ErrCallNotFound) || errors.Is(err, ErrCallEnded) {
					_ = client.conn.Close()
					return
				}
				continue
			}
			msg := stateMessage(call)
			if len(msg) == 0 {
				continue
			}
			if !client.trySend(msg) {
				_ = client.conn.Close()
				return
			}
		case <-stop:
			return
		}
	}
}

func otherPeerOnline(call *models.CallV2, selfPeerID string) bool {
	if call == nil {
		return false
	}
	if selfPeerID == call.Host.PeerID {
		return call.Guest.IsPresent
	}
	return call.Host.IsPresent
}

func stateMessage(call *models.CallV2) []byte {
	if call == nil {
		return nil
	}
	msg, _ := json.Marshal(wsEnvelopeV2{
		Type: "state",
		Data: mustMarshal(wsStateDataV2{
			CallID: call.ID,
			Status: call.Status,
			Participants: callParticipants{
				Count: call.ParticipantsCount(),
			},
		}),
	})
	return msg
}

func (h *Handlers) writeWSCallError(c *gin.Context, err error) {
	switch err {
	case ErrCallNotFound:
		c.JSON(http.StatusNotFound, gin.H{"error": "call not found"})
	case ErrCallEnded:
		c.JSON(http.StatusConflict, gin.H{"error": "call ended"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}
}

func mustMarshal(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
