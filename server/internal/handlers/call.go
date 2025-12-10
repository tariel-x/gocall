package handlers

import (
	"fmt"
	"net/http"
	"net/url"
	"familycall/server/internal/models"
	"familycall/server/internal/websocket"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type InitiateCallRequest struct {
	ContactID string `json:"contact_id" binding:"required"`
	CallType  string `json:"call_type" binding:"required,oneof=audio video"`
}

func (h *Handlers) InitiateCall(c *gin.Context) {
	userID, _ := c.Get("user_id")

	var req InitiateCallRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Validate call type
	if req.CallType != "audio" && req.CallType != "video" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "call_type must be 'audio' or 'video'"})
		return
	}

	// Prevent calling yourself
	if req.ContactID == userID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Cannot call yourself"})
		return
	}

	// Get the contact user (contact_id is now just a user_id)
	var contactUser models.User
	if err := h.db.Where("id = ?", req.ContactID).First(&contactUser).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "Contact not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	// Get caller info
	var caller models.User
	if err := h.db.First(&caller, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get caller info"})
		return
	}

	// Send WebSocket message to callee if online
	message := websocket.Message{
		Type:     "call-request",
		From:     userID.(string),
		To:       contactUser.ID, // contact_id is now user_id
		CallType: req.CallType,
		Data: map[string]interface{}{
			"caller_username": caller.Username,
			"caller_id":       caller.ID,
		},
	}

	messageBytes, _ := websocket.EncodeMessage(message)
	h.hub.Broadcast <- messageBytes

	// Build call URL with parameters (URL encode values)
	callURL := fmt.Sprintf("https://%s/call?caller_id=%s&caller_name=%s&call_type=%s",
		h.config.Domain,
		url.QueryEscape(caller.ID),
		url.QueryEscape(caller.Username),
		url.QueryEscape(req.CallType),
	)
	
	// Send push notification to callee with URL
	go h.SendPushNotification(
		contactUser.ID, // contact_id is now user_id
		"Tap here to answer a call",
		"Tap here to answer a call",
		map[string]interface{}{
			"url": callURL,
		},
	)

	c.JSON(http.StatusOK, gin.H{
		"message": "Call initiated",
		"call_type": req.CallType,
	})
}

