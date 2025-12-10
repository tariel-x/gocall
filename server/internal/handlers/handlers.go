package handlers

import (
	"embed"
	"familycall/server/internal/config"
	"familycall/server/internal/turn"
	"familycall/server/internal/websocket"

	"gorm.io/gorm"
)

type Handlers struct {
	db              *gorm.DB
	hub             *websocket.Hub
	config          *config.Config
	turnServer      *turn.TURNServer
	translationsFS  embed.FS
}

func New(db *gorm.DB, hub *websocket.Hub, config *config.Config, turnServer *turn.TURNServer, translationsFS embed.FS) *Handlers {
	return &Handlers{
		db:             db,
		hub:            hub,
		config:         config,
		turnServer:     turnServer,
		translationsFS: translationsFS,
	}
}

