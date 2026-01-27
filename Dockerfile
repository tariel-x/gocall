# --- Build stage ---
FROM ubuntu:24.04 AS builder

# Deps
RUN apt-get update && \
    apt-get install -y curl make ca-certificates && \
    # Install Go
    curl -LO https://go.dev/dl/go1.25.6.linux-amd64.tar.gz && \
    tar -C /usr/local -xzf go1.25.6.linux-amd64.tar.gz && \
    export PATH=$PATH:/usr/local/go/bin && \
    # Node.js and npm
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs

# Configure go
ENV PATH="/usr/local/go/bin:${PATH}"
WORKDIR /app

# Copy source code
COPY . .

# Build frontend + backend
RUN make install
RUN make all

# --- Release stage ---
FROM alpine:3.19

# Check certs
RUN apk add --no-cache ca-certificates

WORKDIR /app

# Copy bin
COPY --from=builder /app/gocall /app/gocall

# Open ports
EXPOSE 3478 80 443

ENTRYPOINT ["/app/gocall"]