FRONTEND_DIR := frontend
DIST_DIR := internal/static/dist

.PHONY: install frontend-clean frontend server server-linux-x64 all clean

install:
	cd $(FRONTEND_DIR) && npm install
	go mod download

frontend-clean:
	rm -rf $(DIST_DIR)/*
	touch $(DIST_DIR)/.gitkeep

frontend:
	cd $(FRONTEND_DIR) && npm run build

server:
	go build -o gocall ./cmd/server/*.go

all: frontend-clean frontend server

clean: frontend-clean
	rm -f gocall

.PHONY: docker-build
docker-build:
	docker buildx build --platform linux/amd64 -t gocall:latest .
