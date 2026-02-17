package handlers

import (
	"net/http"

	"github.com/tariel-x/gocall/internal/models"

	"github.com/gin-gonic/gin"
)

type createCallResponse struct {
	CallID string              `json:"call_id"`
	Status models.CallStatusV2 `json:"status"`
}

type callParticipants struct {
	Count int `json:"count"`
}

type getCallResponse struct {
	CallID       string              `json:"call_id"`
	Status       models.CallStatusV2 `json:"status"`
	Participants callParticipants    `json:"participants"`
}

type joinCallResponse struct {
	CallID string `json:"call_id"`
	PeerID string `json:"peer_id"`
}

func (h *Handlers) CreateCall(c *gin.Context) {
	call, err := h.calls.CreateCall(h.nowFn())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, createCallResponse{CallID: call.ID, Status: call.Status})
}

func (h *Handlers) GetCall(c *gin.Context) {
	callID := c.Param("call_id")
	call, err := h.calls.GetByID(callID, h.nowFn())
	if err != nil {
		if err == ErrCallNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "call not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, getCallResponse{
		CallID: call.ID,
		Status: call.Status,
		Participants: callParticipants{
			Count: call.ParticipantsCount(),
		},
	})
}

func (h *Handlers) JoinCall(c *gin.Context) {
	callID := c.Param("call_id")
	peerID, call, err := h.calls.Join(callID, h.nowFn())
	if err != nil {
		switch err {
		case ErrCallNotFound:
			c.JSON(http.StatusNotFound, gin.H{"error": "call not found"})
			return
		case ErrCallFull:
			c.JSON(http.StatusConflict, gin.H{"error": "call is full"})
			return
		case ErrCallEnded:
			c.JSON(http.StatusConflict, gin.H{"error": "call ended"})
			return
		default:
			_ = call
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	c.JSON(http.StatusOK, joinCallResponse{CallID: call.ID, PeerID: peerID})
}

func (h *Handlers) LeaveCall(c *gin.Context) {
	callID := c.Param("call_id")
	call, err := h.calls.EndCall(callID, h.nowFn())
	if err != nil {
		if err == ErrCallNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "call not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Notify WS peers about the ended state before closing sockets.
	h.wsHub.Broadcast(callID, stateMessage(call))

	// Close any active WS sessions for this call.
	h.wsHub.CloseCall(callID)

	c.JSON(http.StatusOK, createCallResponse{CallID: call.ID, Status: call.Status})
}
