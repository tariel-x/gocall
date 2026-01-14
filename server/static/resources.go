package static

import (
	"embed"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strings"

	"familycall/server/internal/config"

	"github.com/gin-gonic/gin"
)

const (
	distDir               = "dist"
	apiAddressPlaceholder = "window.API_ADDRESS=\"http://localhost:8080\""
)

//go:embed all:dist
var distFiles embed.FS

// GetFileSystem exposes the embedded dist filesystem (useful for tests/tools).
func GetFileSystem() http.FileSystem {
	return http.FS(distFiles)
}

// RegisterNewUIRoutes wires /newui routes to the embedded React bundle.
func RegisterNewUIRoutes(router *gin.Engine, cfg *config.Config) {
	handler := newUIHandler(cfg)
	router.GET("/newui/*filepath", handler)
}

func newUIHandler(cfg *config.Config) gin.HandlerFunc {
	distFS, err := fs.Sub(distFiles, distDir)
	if err != nil {
		return func(c *gin.Context) {
			c.String(http.StatusServiceUnavailable, "new UI bundle is missing (run `npm run build` inside frontend/)")
		}
	}

	fileServer := http.FileServer(http.FS(distFS))
	stripHandler := http.StripPrefix("/newui", fileServer)

	return func(c *gin.Context) {
		requestPath := strings.TrimPrefix(c.Param("filepath"), "/")
		if c.Request.URL.Path == "/newui" || c.Request.URL.Path == "/newui/" {
			requestPath = ""
		}
		if requestPath == "" || requestPath == "index.html" {
			serveNewUIIndex(c, distFS, cfg)
			return
		}

		if _, err := distFS.Open(requestPath); err != nil {
			serveNewUIIndex(c, distFS, cfg)
			return
		}

		stripHandler.ServeHTTP(c.Writer, c.Request)
		c.Abort()
	}
}

func serveNewUIIndex(c *gin.Context, distFS fs.FS, cfg *config.Config) {
	indexFile, err := distFS.Open("index.html")
	if err != nil {
		c.String(http.StatusServiceUnavailable, "new UI entrypoint not found")
		return
	}
	defer indexFile.Close()

	content, err := io.ReadAll(indexFile)
	if err != nil {
		c.String(http.StatusInternalServerError, "failed to read new UI entrypoint")
		return
	}

	apiAddress := resolveAPIAddress(cfg)
	html := strings.Replace(string(content), apiAddressPlaceholder, fmt.Sprintf("window.API_ADDRESS=\"%s\"", apiAddress), 1)

	c.Header("Content-Type", "text/html; charset=utf-8")
	c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
	c.Header("Pragma", "no-cache")
	c.Header("Expires", "0")
	c.String(http.StatusOK, html)
}

func resolveAPIAddress(cfg *config.Config) string {
	if cfg.BackendOnly && cfg.FrontendURI != "" {
		return cfg.FrontendURI
	}
	return ""
}
