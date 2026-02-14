
# Gocall

**Gocall** is a self-hosted video call service — an "extremely simplified Google Meet". It allows you to create one-on-one video call rooms and share links to them. Without accounts, databases, registrations, and extra features — just simple, private calls.

## Notice

This project is a fork and based on [github.com/ZonD80/familycall](https://github.com/ZonD80/familycall). Thanks to the original author for the foundation.

## Features

- Audio & video call rooms
- Built-in TURN/STUN server
- Single Page Application (SPA)
- No database
- Automatic SSL/TLS
- E2E encryption, no call recording, no analytics, no data sharing
- Self-hosted & single binary

## Quick Start

### Build from source

Currently, only source build is available. Docker image and binaries will be provided later.

1. Install dependencies:
   ```bash
   make install
   ```
2. Build the project:
   ```bash
   make all
   ```
   This will produce the `gocall` binary in the project root.

### Run

#### For production (Let's Encrypt):

```bash
DOMAIN=example.com HTTPS_PORT=443 HTTP_PORT=80 ./gocall
```

- The server will automatically obtain and renew SSL certificates via Let's Encrypt.
- Frontend and API will be available via HTTPS.

#### For local development (self-signed):

```bash
DOMAIN=local-domain ./gocall --self-signed
```

- The server will generate a self-signed certificate for local testing.

#### Behind a reverse proxy (nginx/caddy/etc):

```bash
DOMAIN=example.com ./gocall --http-only
```

- The server will listen on HTTP only, SSL/TLS and certificates are handled by the proxy.
- You must set the `FRONTEND_URI` environment variable (e.g., `FRONTEND_URI=https://example.com`).

## Command-line arguments and environment variables

### Environment variables

- `DOMAIN` — main domain (e.g., `example.com` or `local-domain`)
- `HTTP_PORT` — HTTP port (default: 8080)
- `HTTPS_PORT` — HTTPS port (default: 8443)
- `TURN_PORT` — TURN server port (default: 3478)
- `TURN_REALM` — TURN realm (default: `familycall`)
- `FRONTEND_URI` — external frontend address (required with `--http-only`)

### Command-line arguments

- `--http-only` — run HTTP only (for reverse proxy, disables Let's Encrypt and HTTPS)
- `--self-signed` — run with a self-signed certificate (for local development)


## Security & Privacy

- All calls are encrypted (DTLS-SRTP, WebRTC)
- No call history, logs, user data, or analytics
- No third-party data collection or ads
- Everything runs on your server, full control
