package main

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func slogGinLogger(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		rawQuery := c.Request.URL.RawQuery

		c.Next()

		latency := time.Since(start)
		status := c.Writer.Status()
		errStr := ""
		if len(c.Errors) > 0 {
			errStr = c.Errors.String()
		}

		fields := []any{
			"status", status,
			"method", c.Request.Method,
			"path", path,
			"query", rawQuery,
			"ip", c.ClientIP(),
			"user_agent", c.Request.UserAgent(),
			"latency_ms", latency.Milliseconds(),
		}
		if errStr != "" {
			fields = append(fields, "errors", errStr)
		}

		if status >= 500 {
			logger.Error("http request", fields...)
			return
		}
		logger.Debug("http request", fields...)
	}
}

// newTLSErrorWriter wires net/http server errors (including TLS handshake errors)
// into slog JSON. Some noisy unauthorized-host handshake errors are suppressed.
func newTLSErrorWriter(logger *slog.Logger) io.Writer {
	return &tlsErrorFilter{writer: &slogLineWriter{logger: logger, level: slog.LevelWarn}}
}

// tlsErrorFilter filters out TLS handshake errors for unauthorized hosts.
// It exists to avoid log spam from bots/scanners.
type tlsErrorFilter struct {
	writer io.Writer
}

func (f *tlsErrorFilter) Write(p []byte) (n int, err error) {
	msg := string(p)
	if strings.Contains(msg, "TLS handshake error") && strings.Contains(msg, "not configured") {
		return len(p), nil // discard
	}
	return f.writer.Write(p)
}

type slogLineWriter struct {
	logger *slog.Logger
	level  slog.Level
}

func (w *slogLineWriter) Write(p []byte) (n int, err error) {
	if w == nil || w.logger == nil {
		return len(p), nil
	}
	msg := strings.TrimSpace(string(p))
	if msg == "" {
		return len(p), nil
	}
	w.logger.Log(context.Background(), w.level, "http server", "message", msg)
	return len(p), nil
}
