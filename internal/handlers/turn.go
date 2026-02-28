package handlers

import (
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

type PushSubscribeKeys struct {
	P256DH string `json:"p256dh" binding:"required"`
	Auth   string `json:"auth" binding:"required"`
}

type PushSubscribeRequest struct {
	Endpoint string            `json:"endpoint" binding:"required"`
	Keys     PushSubscribeKeys `json:"keys" binding:"required"`
}

func (h *Handlers) GetTURNConfig(c *gin.Context) {
	// Get TURN server configuration - use only our TURN server
	// TURN servers also support STUN, so we don't need separate STUN servers
	// Note: We use "turn:" (not "turns:") because we're not serving TURN over TLS.
	// We provide both UDP and TCP transports to improve connectivity on restrictive networks.
	// Media encryption is handled by DTLS-SRTP in WebRTC

	host := c.Request.Host
	if idx := strings.Index(host, ":"); idx != -1 {
		host = host[:idx]
	}

	// Get credentials from TURN server
	creds := h.turnServer.GetCredentials()

	// TURN server URLs
	turnURLUDP := fmt.Sprintf("turn:%s:%d", host, h.config.TURNPort)
	turnURLTCP := fmt.Sprintf("turn:%s:%d?transport=tcp", host, h.config.TURNPort)
	// Also include STUN URL (TURN servers support STUN protocol)
	stunURL := fmt.Sprintf("stun:%s:%d", host, h.config.TURNPort)

	iceServers := []map[string]interface{}{
		{
			"urls": stunURL,
		},
		{
			"urls":       []string{turnURLUDP, turnURLTCP},
			"username":   creds.Username,
			"credential": creds.Password,
		},
	}

	log.Printf("TURN config requested - returning %d ICE servers for host %s", len(iceServers), host)

	c.JSON(http.StatusOK, gin.H{
		"iceServers": iceServers,
	})
}
