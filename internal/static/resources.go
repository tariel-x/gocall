package static

import (
	"embed"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	pathpkg "path"
	"strings"

	"github.com/tariel-x/gocall/internal/config"

	"github.com/gin-gonic/gin"
)

const (
	distDir               = "dist"
	apiAddressPlaceholder = "window.API_ADDRESS=\"http://localhost:8080\""
)

//go:embed all:dist
var distFiles embed.FS

// RegisterNewUIRoutes wires /* routes to the embedded React bundle.
func RegisterNewUIRoutes(router *gin.Engine, cfg *config.Config) {
	handler := newUIHandler(cfg)
	// NOTE: Gin can't combine a root catch-all (e.g. /*filepath) with other
	// top-level routes like /api. Use NoRoute as an SPA fallback instead.
	router.NoRoute(handler)
}

func newUIHandler(cfg *config.Config) gin.HandlerFunc {
	distFS, err := fs.Sub(distFiles, distDir)
	if err != nil {
		return func(c *gin.Context) {
			c.String(http.StatusServiceUnavailable, "new UI bundle is missing (run `npm run build` inside frontend/)")
		}
	}

	fileServer := http.FileServer(http.FS(distFS))

	return func(c *gin.Context) {
		// Never fall back to SPA for API paths.
		if strings.HasPrefix(c.Request.URL.Path, "/api") {
			c.Status(http.StatusNotFound)
			return
		}

		requestPath := strings.TrimPrefix(c.Request.URL.Path, "/")
		if requestPath == "" || requestPath == "index.html" {
			serveNewUIIndex(c, distFS, cfg)
			return
		}

		// Normalize path and prevent path traversal attempts.
		cleaned := pathpkg.Clean("/" + requestPath)
		if strings.HasPrefix(cleaned, "/..") {
			c.Status(http.StatusNotFound)
			return
		}
		requestPath = strings.TrimPrefix(cleaned, "/")
		if requestPath == "" {
			serveNewUIIndex(c, distFS, cfg)
			return
		}

		info, err := fs.Stat(distFS, requestPath)
		if err != nil || info.IsDir() {
			serveNewUIIndex(c, distFS, cfg)
			return
		}

		// Make sure the file server sees the cleaned path.
		c.Request.URL.Path = "/" + requestPath
		fileServer.ServeHTTP(c.Writer, c.Request)
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
	if c.Request.Method == http.MethodHead {
		c.Status(http.StatusOK)
		return
	}
	c.String(http.StatusOK, html)
}

func resolveAPIAddress(cfg *config.Config) string {
	if cfg.HTTPOnly && cfg.FrontendURI != "" {
		return cfg.FrontendURI
	}
	return ""
}
