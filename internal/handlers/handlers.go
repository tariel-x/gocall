package handlers

import (
	"github.com/tariel-x/gocall/internal/config"
	"github.com/tariel-x/gocall/internal/turn"
	"github.com/tariel-x/gocall/internal/websocket"
)

type Handlers struct {
	hub        *websocket.Hub
	config     *config.Config
	turnServer *turn.TURNServer
}

func New(hub *websocket.Hub, config *config.Config, turnServer *turn.TURNServer) *Handlers {
	return &Handlers{
		hub:        hub,
		config:     config,
		turnServer: turnServer,
	}
}
