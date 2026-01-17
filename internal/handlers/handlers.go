package handlers

import (
	"time"

	"github.com/gorilla/websocket"

	"github.com/tariel-x/gocall/internal/config"
	"github.com/tariel-x/gocall/internal/turn"
)

type Handlers struct {
	config     *config.Config
	turnServer *turn.TURNServer
	calls      *CallStore
	wsHub      *WSHubV2
	wsUpgrader websocket.Upgrader
	nowFn      func() time.Time
}

func New(
	config *config.Config,
	turnServer *turn.TURNServer,
	calls *CallStore,
	wsHub *WSHubV2,
	wsUpgrader websocket.Upgrader,
) *Handlers {
	return &Handlers{
		config:     config,
		turnServer: turnServer,
		calls:      calls,
		wsHub:      wsHub,
		wsUpgrader: wsUpgrader,
		nowFn:      time.Now,
	}
}
