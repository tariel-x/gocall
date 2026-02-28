package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	HTTPPort  string
	HTTPSPort string
	Domain    string
	TURNPort  int
	TURNRealm string
	LogLevel  string
	// Backend-only mode fields
	HTTPOnly    bool
	FrontendURI string
}

// Load loads configuration from config.json (if exists) and overrides with command-line flags
func Load(httpOnly *bool) *Config {
	var cfg *Config

	// Initialize with defaults
	cfg = &Config{
		HTTPPort:  getEnv("HTTP_PORT", "8080"),
		HTTPSPort: getEnv("HTTPS_PORT", "8443"),
		Domain:    getEnv("DOMAIN", "localhost"),
		TURNPort:  getEnvInt("TURN_PORT", 3478),
		TURNRealm: getEnv("TURN_REALM", "familycall"),
		LogLevel:  strings.ToLower(getEnv("LOG_LEVEL", "info")),

		FrontendURI: getEnv("FRONTEND_URI", ""),
	}

	// Override with command-line flags if provided
	if httpOnly != nil {
		cfg.HTTPOnly = *httpOnly

		// Normalize frontend URI (remove trailing slash)
		cfg.FrontendURI = strings.TrimSuffix(cfg.FrontendURI, "/")
	}

	return cfg
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intValue, err := strconv.Atoi(value); err == nil {
			return intValue
		}
	}
	return defaultValue
}
