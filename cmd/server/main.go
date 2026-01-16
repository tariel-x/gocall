package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tariel-x/gocall/internal/config"
	"github.com/tariel-x/gocall/internal/handlers"
	"github.com/tariel-x/gocall/internal/handlersv2"
	"github.com/tariel-x/gocall/internal/static"
	"github.com/tariel-x/gocall/internal/turn"
	"github.com/tariel-x/gocall/internal/websocket"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/acme/autocert"
)

const AppVersion = "1.0.0"

// Build timestamp - set at compile time or use current time
var buildTimestamp = time.Now().Unix()

func main() {
	// Parse command-line flags
	backendOnly := flag.Bool("backend-only", false, "Run in backend-only mode (disable SSL/LE, use HTTP)")
	backendPort := flag.String("port", "", "HTTP port for backend-only mode (required with --backend-only)")
	frontendURI := flag.String("frontend-uri", "", "Frontend URI base (e.g., https://domain.host) (required with --backend-only)")
	selfSigned := flag.Bool("self-signed", false, "Enable HTTPS using a generated self-signed certificate (explicitly, no localhost auto-detect)")
	flag.Parse()

	// Validate flags
	if *backendOnly {
		if *backendPort == "" {
			log.Fatal("Error: --port is required when --backend-only is specified")
		}
		if *frontendURI == "" {
			log.Fatal("Error: --frontend-uri is required when --backend-only is specified")
		}
		// Normalize frontend URI (remove trailing slash)
		*frontendURI = strings.TrimSuffix(*frontendURI, "/")
	}

	// Log version and build info
	log.Printf("Family Callbook Server v%s (build: %d)", AppVersion, buildTimestamp)

	// Load configuration (from config.json if exists, override with flags)
	cfg := config.Load(backendOnly, backendPort, frontendURI)

	// Save config.json if flags were provided
	if *backendOnly || (*backendPort != "" || *frontendURI != "") {
		if err := config.SaveConfigToJSON(cfg); err != nil {
			log.Printf("Warning: Failed to save config.json: %v", err)
		} else {
			log.Printf("Configuration saved to config.json")
		}
	}

	// Initialize WebSocket hub
	hub := websocket.NewHub()
	go hub.Run()

	// Initialize TURN server
	turnServer, err := turn.Initialize(cfg.TURNPort, cfg.TURNRealm)
	if err != nil {
		log.Fatalf("Failed to initialize TURN server: %v", err)
	}
	defer turnServer.Close()

	log.Printf("TURN server started on port %d", cfg.TURNPort)

	// Initialize handlers
	h := handlers.New(hub, cfg, turnServer)

	// Setup router
	router := setupRouter(h, cfg)

	// Setup server (HTTPS with Let's Encrypt or HTTP for backend-only)
	startHTTPServer(router, cfg, *selfSigned)
}

func setupRouter(h *handlers.Handlers, cfg *config.Config) *gin.Engine {
	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}

	router := gin.Default()

	// CORS middleware (for web app)
	router.Use(func(c *gin.Context) {
		// Use frontend URI for CORS if in backend-only mode, otherwise allow all
		origin := "*"
		if cfg.BackendOnly && cfg.FrontendURI != "" {
			origin = cfg.FrontendURI
		}
		c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, DELETE")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	})

	// Public routes
	api := router.Group("/api")
	{
		api.GET("/vapid-public-key", h.GetVAPIDPublicKey)
		api.GET("/turn-config", h.GetTURNConfig)
	}

	// Public apiv2 routes (no auth, MVP call flow)
	hv2 := handlersv2.New()
	apiv2 := router.Group("/apiv2")
	{
		apiv2.POST("/calls", hv2.CreateCall)
		apiv2.GET("/calls/:call_id", hv2.GetCall)
		apiv2.POST("/calls/:call_id/join", hv2.JoinCall)
		apiv2.POST("/calls/:call_id/leave", hv2.LeaveCall)
		apiv2.GET("/ws", hv2.HandleWebSocket)
	}

	// New React UI routes under /newui
	static.RegisterNewUIRoutes(router, cfg)

	return router
}

func startHTTPServer(router *gin.Engine, cfg *config.Config, selfSigned bool) {
	// Backend-only mode: simple HTTP server
	if cfg.BackendOnly {
		httpServer := &http.Server{
			Addr:         ":" + cfg.BackendPort,
			Handler:      router,
			ReadTimeout:  15 * time.Second,
			WriteTimeout: 15 * time.Second,
			IdleTimeout:  60 * time.Second,
		}

		log.Printf("Backend-only mode: HTTP server starting on port %s", cfg.BackendPort)
		log.Printf("Frontend URI: %s", cfg.FrontendURI)
		log.Printf("SSL/TLS and Let's Encrypt certificate management disabled")
		log.Printf("API calls will use: %s/api", cfg.FrontendURI)

		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Failed to start HTTP server: %v", err)
		}
		return
	}

	if selfSigned {
		// Self-signed mode: HTTPS with a generated self-signed certificate
		log.Println("Self-signed TLS enabled - generating self-signed certificate")

		hosts := []string{"localhost"}
		if cfg.Domain != "" {
			hosts = []string{cfg.Domain}
		}
		certPEM, keyPEM, err := generateSelfSignedCert(hosts)
		if err != nil {
			log.Fatalf("Failed to generate self-signed certificate: %v", err)
		}

		cert, err := tls.X509KeyPair(certPEM, keyPEM)
		if err != nil {
			log.Fatalf("Failed to load self-signed certificate: %v", err)
		}

		tlsConfig := &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		}

		httpsServer := &http.Server{
			Addr:         ":" + cfg.HTTPSPort,
			Handler:      router,
			TLSConfig:    tlsConfig,
			ReadTimeout:  15 * time.Second,
			WriteTimeout: 15 * time.Second,
			IdleTimeout:  60 * time.Second,
		}

		// Start HTTP redirect server
		go func() {
			redirectHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				host := r.Host
				if idx := strings.Index(host, ":"); idx != -1 {
					host = host[:idx]
				}
				target := "https://" + host + ":" + cfg.HTTPSPort + r.URL.Path
				if r.URL.RawQuery != "" {
					target += "?" + r.URL.RawQuery
				}
				http.Redirect(w, r, target, http.StatusMovedPermanently)
			})
			httpServer := &http.Server{
				Addr:    ":" + cfg.HTTPPort,
				Handler: redirectHandler,
			}
			log.Printf("HTTP redirect server starting on port %s", cfg.HTTPPort)
			if err := httpServer.ListenAndServe(); err != nil {
				log.Printf("HTTP redirect server error: %v", err)
			}
		}()

		hostForLog := cfg.Domain
		if hostForLog == "" {
			hostForLog = "localhost"
		}
		log.Printf("HTTPS server (self-signed) starting on port %s", cfg.HTTPSPort)
		log.Printf("Access at: https://%s:%s", hostForLog, cfg.HTTPSPort)
		log.Printf("WASM UI at: https://%s:%s/newui/", hostForLog, cfg.HTTPSPort)
		log.Printf("WARNING: Using self-signed certificate. Your browser will show a security warning.")
		log.Printf("         Accept the certificate to continue (safe for local development).")

		if err := httpsServer.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Failed to start HTTPS server: %v", err)
		}
		return
	}

	// Normal mode: HTTPS with Let's Encrypt
	// Get certs directory
	certsDir := getCertsDirectory()
	if err := os.MkdirAll(certsDir, 0700); err != nil {
		log.Fatalf("Failed to create certs directory: %v", err)
	}

	// Normalize domain (remove www. prefix if present, convert to lowercase)
	normalizedDomain := normalizeDomain(cfg.Domain)
	log.Printf("Configured domain: %s (normalized: %s)", cfg.Domain, normalizedDomain)

	// Configure autocert manager with custom HostPolicy for better error handling
	m := &autocert.Manager{
		Prompt: autocert.AcceptTOS,
		HostPolicy: func(ctx context.Context, host string) error {
			normalizedHost := normalizeDomain(host)
			if normalizedHost != normalizedDomain {
				// Silently reject - don't log to avoid spam from bots/scanners
				return fmt.Errorf("host %q not configured (expected %q)", host, normalizedDomain)
			}
			return nil
		},
		Cache: autocert.DirCache(certsDir),
	}

	// Create HTTP handler that redirects to HTTPS, but allows ACME challenges
	// Use autocert's HTTP handler for ACME challenges, then redirect everything else
	redirectHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Redirect all HTTP traffic to HTTPS
		httpsURL := "https://" + r.Host + r.RequestURI
		http.Redirect(w, r, httpsURL, http.StatusMovedPermanently)
	})

	// Chain handlers: autocert first (for ACME challenges), then redirect
	httpHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check if this is an ACME challenge
		if strings.HasPrefix(r.URL.Path, "/.well-known/acme-challenge/") {
			m.HTTPHandler(nil).ServeHTTP(w, r)
			return
		}
		// Otherwise redirect to HTTPS
		redirectHandler.ServeHTTP(w, r)
	})

	// Create a custom error logger that filters out TLS handshake errors for unauthorized hosts
	errorLog := log.New(&tlsErrorFilter{writer: os.Stderr}, "", log.LstdFlags)

	// Create HTTP server for Let's Encrypt challenge and redirects (port 80)
	httpServer := &http.Server{
		Addr:         ":" + cfg.HTTPPort,
		Handler:      httpHandler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
		ErrorLog:     errorLog,
	}

	// Create HTTPS server (port 443) with custom error logger to suppress TLS handshake errors
	httpsServer := &http.Server{
		Addr:         ":" + cfg.HTTPSPort,
		Handler:      router,
		TLSConfig:    m.TLSConfig(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
		ErrorLog:     errorLog,
	}

	// Start HTTP server in goroutine (for Let's Encrypt challenge and redirects)
	go func() {
		log.Printf("HTTP server (ACME challenge & redirects) starting on port %s", cfg.HTTPPort)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Failed to start HTTP server: %v", err)
		}
	}()

	// Start certificate renewal goroutine
	go startCertificateRenewal(m, normalizedDomain, certsDir)

	// Start HTTPS server
	log.Printf("HTTPS server starting on port %s for domain: %s", cfg.HTTPSPort, normalizedDomain)
	log.Printf("Certificates will be stored in: %s", certsDir)
	log.Printf("Only requests for '%s' will be accepted. Other domains will be rejected.", normalizedDomain)
	if normalizedDomain == "localhost" || normalizedDomain == "127.0.0.1" {
		log.Println("WARNING: Let's Encrypt will not work for localhost. Use --self-signed for local development.")
	}

	if err := httpsServer.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Failed to start HTTPS server: %v", err)
	}
}

// startCertificateRenewal runs a background goroutine that checks and renews certificates monthly
func startCertificateRenewal(m *autocert.Manager, domain string, certsDir string) {
	// Wait a bit for initial certificate to be obtained
	time.Sleep(30 * time.Second)

	// Run renewal check every month (30 days)
	ticker := time.NewTicker(30 * 24 * time.Hour)
	defer ticker.Stop()

	// Run immediately on startup, then every month
	checkAndRenewCertificate(m, domain, certsDir)

	for range ticker.C {
		checkAndRenewCertificate(m, domain, certsDir)
	}
}

// checkAndRenewCertificate checks if certificate needs renewal and triggers renewal if needed
func checkAndRenewCertificate(m *autocert.Manager, domain string, certsDir string) {
	log.Printf("[CERT] Checking certificate expiration for domain: %s", domain)

	// Get certificate from cache
	cert, err := m.GetCertificate(&tls.ClientHelloInfo{
		ServerName: domain,
	})
	if err != nil {
		log.Printf("[CERT] Error getting certificate: %v (will be obtained on next request)", err)
		return
	}

	if cert == nil || len(cert.Certificate) == 0 {
		log.Printf("[CERT] No certificate found in cache (will be obtained on next request)")
		return
	}

	// Parse certificate to check expiration
	var x509Cert *x509.Certificate
	if cert.Leaf != nil {
		// Certificate already parsed
		x509Cert = cert.Leaf
	} else if len(cert.Certificate) > 0 {
		// Parse from raw certificate bytes
		var err error
		x509Cert, err = x509.ParseCertificate(cert.Certificate[0])
		if err != nil {
			log.Printf("[CERT] Error parsing certificate: %v", err)
			// Trigger renewal anyway by accessing the certificate
			log.Printf("[CERT] Triggering certificate check/renewal for domain: %s", domain)
			_, _ = m.GetCertificate(&tls.ClientHelloInfo{ServerName: domain})
			return
		}
	} else {
		log.Printf("[CERT] No certificate data available")
		return
	}

	// Check if certificate expires within 30 days
	now := time.Now()
	expiresIn := x509Cert.NotAfter.Sub(now)
	daysUntilExpiry := int(expiresIn.Hours() / 24)

	log.Printf("[CERT] Certificate expires in %d days (expires: %s)", daysUntilExpiry, x509Cert.NotAfter.Format("2006-01-02"))

	if daysUntilExpiry < 30 {
		log.Printf("[CERT] Certificate expires soon (%d days), triggering renewal...", daysUntilExpiry)
		// Force renewal by getting a new certificate
		// This will trigger autocert's renewal logic
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()

		// Create a dummy request to trigger certificate renewal
		// The autocert manager will handle the renewal automatically
		_, err := m.GetCertificate(&tls.ClientHelloInfo{
			ServerName: domain,
		})
		if err != nil {
			log.Printf("[CERT] Error during renewal: %v", err)
		} else {
			log.Printf("[CERT] Certificate renewal triggered successfully")
		}
		_ = ctx
	} else {
		log.Printf("[CERT] Certificate is still valid for %d more days, no renewal needed", daysUntilExpiry)
	}
}

func getCertsDirectory() string {
	// Get directory where the executable is located
	execPath, err := os.Executable()
	if err != nil {
		// Fallback to current directory
		return "certs"
	}
	execDir := filepath.Dir(execPath)
	return filepath.Join(execDir, "certs")
}

// tlsErrorFilter filters out TLS handshake errors for unauthorized hosts
type tlsErrorFilter struct {
	writer io.Writer
}

func (f *tlsErrorFilter) Write(p []byte) (n int, err error) {
	msg := string(p)
	// Filter out TLS handshake errors for unauthorized hosts
	if strings.Contains(msg, "TLS handshake error") && strings.Contains(msg, "not configured") {
		return len(p), nil // Discard the message
	}
	return f.writer.Write(p)
}

// normalizeDomain normalizes a domain name for comparison
// - Converts to lowercase
// - Removes www. prefix if present
// - Trims whitespace
func normalizeDomain(domain string) string {
	domain = strings.ToLower(strings.TrimSpace(domain))
	// Remove www. prefix if present
	domain = strings.TrimPrefix(domain, "www.")
	return domain
}

// generateSelfSignedCert creates a self-signed certificate for localhost
func generateSelfSignedCert(hosts []string) (certPEM, keyPEM []byte, err error) {
	// Generate private key
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to generate private key: %w", err)
	}

	// Generate a random serial number
	serialNumberLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serialNumber, err := rand.Int(rand.Reader, serialNumberLimit)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to generate serial number: %w", err)
	}

	// Create certificate template
	notBefore := time.Now()
	notAfter := notBefore.Add(365 * 24 * time.Hour) // Valid for 1 year

	dnsNames := make([]string, 0, len(hosts))
	ipAddrs := make([]net.IP, 0, len(hosts))
	for _, h := range hosts {
		h = strings.TrimSpace(h)
		if h == "" {
			continue
		}
		// Strip port if present.
		if idx := strings.Index(h, ":"); idx != -1 {
			h = h[:idx]
		}
		if ip := net.ParseIP(h); ip != nil {
			ipAddrs = append(ipAddrs, ip)
			continue
		}
		dnsNames = append(dnsNames, h)
	}
	if len(dnsNames) == 0 && len(ipAddrs) == 0 {
		dnsNames = []string{"localhost"}
	}

	commonName := "localhost"
	if len(dnsNames) > 0 {
		commonName = dnsNames[0]
	} else if len(ipAddrs) > 0 {
		commonName = ipAddrs[0].String()
	}

	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"Family Callbook Development"},
			CommonName:   commonName,
		},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              dnsNames,
		IPAddresses:           ipAddrs,
	}

	// Create self-signed certificate
	derBytes, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create certificate: %w", err)
	}

	// Encode certificate to PEM
	certBuffer := new(bytes.Buffer)
	if err := pem.Encode(certBuffer, &pem.Block{Type: "CERTIFICATE", Bytes: derBytes}); err != nil {
		return nil, nil, fmt.Errorf("failed to encode certificate: %w", err)
	}

	// Encode private key to PEM
	privBytes, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to marshal private key: %w", err)
	}

	keyBuffer := new(bytes.Buffer)
	if err := pem.Encode(keyBuffer, &pem.Block{Type: "EC PRIVATE KEY", Bytes: privBytes}); err != nil {
		return nil, nil, fmt.Errorf("failed to encode private key: %w", err)
	}

	return certBuffer.Bytes(), keyBuffer.Bytes(), nil
}
