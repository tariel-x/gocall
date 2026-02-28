package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type clientConfigResponse struct {
	Debug bool `json:"debug"`
}

func (h *Handlers) GetClientConfig(c *gin.Context) {
	c.JSON(http.StatusOK, clientConfigResponse{
		Debug: h.config != nil && h.config.LogLevel == "debug",
	})
}
