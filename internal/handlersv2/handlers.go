package handlersv2

import (
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

type HandlersV2 struct {
	calls *CallStore
	wsHub *WSHubV2
	wsUpgrader websocket.Upgrader
	nowFn func() time.Time
}

func New() *HandlersV2 {
	return &HandlersV2{
		calls: NewCallStore(),
		wsHub: NewWSHubV2(),
		wsUpgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				return true
			},
		},
		nowFn: time.Now,
	}
}
