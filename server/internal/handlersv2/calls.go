package handlersv2

import (
	"net/http"

	"familycall/server/internal/models"

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

func (h *HandlersV2) CreateCall(c *gin.Context) {
	call, err := h.calls.CreateCall(h.nowFn())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, createCallResponse{CallID: call.ID, Status: call.Status})
}

func (h *HandlersV2) GetCall(c *gin.Context) {
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

func (h *HandlersV2) JoinCall(c *gin.Context) {
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

func (h *HandlersV2) LeaveCall(c *gin.Context) {
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

	// Close any active WS sessions for this call.
	h.wsHub.CloseCall(callID)

	c.JSON(http.StatusOK, createCallResponse{CallID: call.ID, Status: call.Status})
}
