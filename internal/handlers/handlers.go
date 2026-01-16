package handlers

import (
	"github.com/tariel-x/gocall/internal/config"
	"github.com/tariel-x/gocall/internal/turn"
)

type Handlers struct {
	config     *config.Config
	turnServer *turn.TURNServer
}

func New(config *config.Config, turnServer *turn.TURNServer) *Handlers {
	return &Handlers{
		config:     config,
		turnServer: turnServer,
	}
}
