package handlers

import (
	"encoding/json"
	"errors"
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

	conn, err := h.wsUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}

	client := &wsClientV2{
		conn:   conn,
		send:   make(chan []byte, 32),
		callID: callID,
		peerID: peerID,
	}

	h.wsHub.Add(client)

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
	client.send <- joinMsg

	if reconnected {
		reconnectMsg, _ := json.Marshal(wsEnvelopeV2{Type: "peer-reconnected", From: peerID})
		h.wsHub.SendToOther(callID, peerID, reconnectMsg)
	}

	h.broadcastState(call)

	stopHeartbeat := make(chan struct{})
	go h.writePump(client)
	go h.heartbeatState(client, stopHeartbeat)
	h.readPump(client)
	close(stopHeartbeat)
}

func (h *Handlers) readPump(client *wsClientV2) {
	defer func() {
		_ = client.conn.Close()
		h.calls.MarkPeerDisconnected(client.callID, client.peerID, h.nowFn())
		h.wsHub.Remove(client.callID, client.peerID)

		// Do not end the call on disconnect.
		// Clients may navigate between SPA screens and reconnect.
		disconnectMsg, _ := json.Marshal(wsEnvelopeV2{Type: "peer-disconnected", From: client.peerID})
		h.wsHub.SendToOther(client.callID, client.peerID, disconnectMsg)
	}()

	_ = client.conn.SetReadDeadline(time.Now().Add(wsPongWait))
	client.conn.SetPongHandler(func(string) error {
		_ = client.conn.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})

	for {
		_, payload, err := client.conn.ReadMessage()
		if err != nil {
			return
		}

		var msg wsEnvelopeV2
		if err := json.Unmarshal(payload, &msg); err != nil {
			continue
		}

		if msg.Type == "ping" {
			continue
		}

		msg.From = client.peerID
		forward, err := json.Marshal(msg)
		if err != nil {
			continue
		}

		if msg.To != "" {
			h.wsHub.SendTo(client.callID, msg.To, forward)
			continue
		}

		// If 'to' is omitted, route to the other participant.
		h.wsHub.SendToOther(client.callID, client.peerID, forward)
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
			select {
			case client.send <- msg:
			default:
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
