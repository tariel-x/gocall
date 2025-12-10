package handlers

import (
	"net/http"
	ws "familycall/server/internal/websocket"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins in development
	},
}

func (h *Handlers) HandleWebSocket(c *gin.Context) {
	// Get user ID from query parameter or JWT token
	userID := c.Query("user_id")
	if userID == "" {
		c.JSON(401, gin.H{"error": "user_id required"})
		return
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}

	client := ws.NewClient(userID, conn, h.hub)
	h.hub.Register <- client

	go client.WritePump()
	go client.ReadPump()
}
