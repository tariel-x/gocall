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

func (h *Handlers) GetVAPIDPublicKey(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"publicKey": h.config.VAPIDKeys.PublicKey,
	})
}

func (h *Handlers) GetTURNConfig(c *gin.Context) {
	// Get TURN server configuration - use only our TURN server
	// TURN servers also support STUN, so we don't need separate STUN servers
	// Note: We use "turn:" (not "turns:") because our TURN server is UDP-only
	// TURNS (TLS) requires TCP/TLS, but we're using UDP which doesn't support TLS
	// Media encryption is handled by DTLS-SRTP in WebRTC

	host := c.Request.Host
	if idx := strings.Index(host, ":"); idx != -1 {
		host = host[:idx]
	}

	// Get credentials from TURN server
	creds := h.turnServer.GetCredentials()

	// TURN server URL - format: turn:host:port
	// Also include STUN URL (TURN servers support STUN protocol)
	turnURL := fmt.Sprintf("turn:%s:%d", host, h.config.TURNPort)
	stunURL := fmt.Sprintf("stun:%s:%d", host, h.config.TURNPort)

	iceServers := []map[string]interface{}{
		{
			"urls": stunURL,
		},
		{
			"urls":       turnURL,
			"username":   creds.Username,
			"credential": creds.Password,
		},
	}

	log.Printf("TURN config requested - returning %d ICE servers for host %s", len(iceServers), host)

	c.JSON(http.StatusOK, gin.H{
		"iceServers": iceServers,
	})
}
