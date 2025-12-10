package config

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	HTTPPort     string
	HTTPSPort    string
	Domain       string
	TURNPort     int
	TURNRealm    string
	DatabasePath string
	JWTSecret    string
	VAPIDKeys    *VAPIDKeys
}

type VAPIDKeys struct {
	PublicKey  string
	PrivateKey string
	Subject    string
}

func Load() *Config {
	cfg := &Config{
		HTTPPort:     getEnv("HTTP_PORT", "80"),   // HTTP port for Let's Encrypt challenge
		HTTPSPort:    getEnv("HTTPS_PORT", "443"), // HTTPS port
		TURNPort:     getEnvInt("TURN_PORT", 3478),
		TURNRealm:    getEnv("TURN_REALM", "familycall"),
		DatabasePath: getEnv("DATABASE_PATH", "familycall.db"),
		JWTSecret:    loadOrGenerateJWTSecret(),
	}

	// Load or prompt for domain
	cfg.Domain = loadOrPromptDomain()

	// Generate or load VAPID keys
	vapidKeys := loadVAPIDKeys()
	cfg.VAPIDKeys = vapidKeys

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

func generateRandomSecret() string {
	bytes := make([]byte, 32)
	rand.Read(bytes)
	return base64.URLEncoding.EncodeToString(bytes)
}

func loadOrGenerateJWTSecret() string {
	// Try environment variable first (highest priority)
	if secret := os.Getenv("JWT_SECRET"); secret != "" {
		return secret
	}

	// Try to load from keys directory
	keysDir := getKeysDirectory()
	secretFile := filepath.Join(keysDir, "jwt-secret.key")

	if secretData, err := os.ReadFile(secretFile); err == nil {
		secret := strings.TrimSpace(string(secretData))
		if secret != "" {
			fmt.Printf("JWT secret loaded from: %s\n", secretFile)
			return secret
		}
	}

	// Generate new secret
	secret := generateRandomSecret()

	// Save secret to file
	if err := os.MkdirAll(keysDir, 0700); err == nil {
		if err := os.WriteFile(secretFile, []byte(secret), 0600); err == nil {
			fmt.Printf("JWT secret saved to: %s\n", secretFile)
		} else {
			fmt.Printf("Warning: Failed to save JWT secret to disk: %v\n", err)
			fmt.Println("Secret will be regenerated on next restart unless set via JWT_SECRET environment variable")
		}
	}

	return secret
}

func loadVAPIDKeys() *VAPIDKeys {
	// Try to load from environment first (highest priority)
	publicKey := os.Getenv("VAPID_PUBLIC_KEY")
	privateKey := os.Getenv("VAPID_PRIVATE_KEY")
	subject := os.Getenv("VAPID_SUBJECT")

	if publicKey != "" && privateKey != "" {
		return &VAPIDKeys{
			PublicKey:  publicKey,
			PrivateKey: privateKey,
			Subject:    getEnv("VAPID_SUBJECT", "mailto:admin@familycall.app"),
		}
	}

	// Try to load from keys directory
	keysDir := getKeysDirectory()
	publicKeyFile := filepath.Join(keysDir, "vapid-public.key")
	privateKeyFile := filepath.Join(keysDir, "vapid-private.key")
	subjectFile := filepath.Join(keysDir, "vapid-subject.key")

	if publicKeyData, err := os.ReadFile(publicKeyFile); err == nil {
		if privateKeyData, err := os.ReadFile(privateKeyFile); err == nil {
			publicKey = string(publicKeyData)
			privateKey = string(privateKeyData)
			
			// Check if private key is in old PKCS#8 format (should be ~138 bytes when decoded)
			// New format should be 32 bytes (raw private key)
			decodedPrivate, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(privateKey))
			if err == nil {
				if len(decodedPrivate) > 50 {
					// Old PKCS#8 format detected - need to convert or regenerate
					fmt.Printf("WARNING: VAPID private key is in old PKCS#8 format (%d bytes). ", len(decodedPrivate))
					fmt.Printf("Deleting old keys to regenerate in correct format...\n")
					os.Remove(publicKeyFile)
					os.Remove(privateKeyFile)
					os.Remove(subjectFile)
					// Fall through to generate new keys
				} else if len(decodedPrivate) == 32 {
					// Valid raw format
					if subjectData, err := os.ReadFile(subjectFile); err == nil {
						subject = string(subjectData)
					} else {
						subject = getEnv("VAPID_SUBJECT", "mailto:admin@familycall.app")
					}

					return &VAPIDKeys{
						PublicKey:  publicKey,
						PrivateKey: privateKey,
						Subject:    subject,
					}
				} else {
					fmt.Printf("WARNING: VAPID private key has unexpected length (%d bytes). ", len(decodedPrivate))
					fmt.Printf("Deleting to regenerate...\n")
					os.Remove(publicKeyFile)
					os.Remove(privateKeyFile)
					os.Remove(subjectFile)
					// Fall through to generate new keys
				}
			} else {
				// Can't decode - might be corrupted, regenerate
				fmt.Printf("WARNING: Cannot decode VAPID private key. Regenerating...\n")
				os.Remove(publicKeyFile)
				os.Remove(privateKeyFile)
				os.Remove(subjectFile)
				// Fall through to generate new keys
			}
		}
	}

	// Generate new VAPID keys
	privateKeyECDSA, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic("Failed to generate VAPID keys: " + err.Error())
	}

	// Generate uncompressed public key (65 bytes: 0x04 + 32 bytes X + 32 bytes Y)
	publicKeyBytes := make([]byte, 65)
	publicKeyBytes[0] = 0x04 // Uncompressed point prefix
	privateKeyECDSA.PublicKey.X.FillBytes(publicKeyBytes[1:33])
	privateKeyECDSA.PublicKey.Y.FillBytes(publicKeyBytes[33:65])

	// Encode uncompressed public key to base64 URL-safe (no padding) for browser
	uncompressedPublicKey := base64.RawURLEncoding.EncodeToString(publicKeyBytes)

	// Extract raw private key bytes (32 bytes for P-256 curve)
	// The webpush library expects raw private key bytes, NOT PKCS#8 format
	privateKeyBytes := make([]byte, 32)
	privateKeyECDSA.D.FillBytes(privateKeyBytes)
	
	// Encode raw private key bytes to base64 URL-safe (no padding) for webpush library
	// This matches the format returned by webpush.GenerateVAPIDKeys()
	privateKeyBase64 := base64.RawURLEncoding.EncodeToString(privateKeyBytes)

	subject = getEnv("VAPID_SUBJECT", "mailto:admin@familycall.app")

	// Save keys to files
	if err := saveVAPIDKeys(keysDir, uncompressedPublicKey, privateKeyBase64, subject); err != nil {
		fmt.Printf("Warning: Failed to save VAPID keys to disk: %v\n", err)
		fmt.Println("Keys will be regenerated on next restart unless set via environment variables")
	}

	return &VAPIDKeys{
		PublicKey:  uncompressedPublicKey, // Uncompressed 65-byte key for browser
		PrivateKey: privateKeyBase64,      // Raw 32-byte private key for webpush library
		Subject:    subject,
	}
}

func getKeysDirectory() string {
	// Get directory where the executable is located
	execPath, err := os.Executable()
	if err != nil {
		// Fallback to current directory
		return "keys"
	}
	execDir := filepath.Dir(execPath)
	return filepath.Join(execDir, "keys")
}

func saveVAPIDKeys(keysDir, publicKey, privateKey, subject string) error {
	// Create keys directory if it doesn't exist
	if err := os.MkdirAll(keysDir, 0700); err != nil {
		return fmt.Errorf("failed to create keys directory: %w", err)
	}

	// Save public key
	publicKeyFile := filepath.Join(keysDir, "vapid-public.key")
	if err := os.WriteFile(publicKeyFile, []byte(publicKey), 0600); err != nil {
		return fmt.Errorf("failed to save public key: %w", err)
	}

	// Save private key
	privateKeyFile := filepath.Join(keysDir, "vapid-private.key")
	if err := os.WriteFile(privateKeyFile, []byte(privateKey), 0600); err != nil {
		return fmt.Errorf("failed to save private key: %w", err)
	}

	// Save subject
	subjectFile := filepath.Join(keysDir, "vapid-subject.key")
	if err := os.WriteFile(subjectFile, []byte(subject), 0600); err != nil {
		return fmt.Errorf("failed to save subject: %w", err)
	}

	fmt.Printf("VAPID keys saved to: %s\n", keysDir)
	return nil
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

func loadOrPromptDomain() string {
	// Try environment variable first
	if domain := os.Getenv("DOMAIN"); domain != "" {
		return domain
	}

	// Try to load from certs directory
	certsDir := getCertsDirectory()
	domainFile := filepath.Join(certsDir, "domain.txt")
	if domainData, err := os.ReadFile(domainFile); err == nil {
		domain := strings.TrimSpace(string(domainData))
		if domain != "" {
			return domain
		}
	}

	// Prompt for domain
	fmt.Println("\n=== Domain Configuration ===")
	fmt.Println("No domain configured. Please enter your domain name for Let's Encrypt SSL certificate.")
	fmt.Println("Example: example.com or subdomain.example.com")
	fmt.Println("Note: For Let's Encrypt to work, your domain must point to this server's IP address.")
	fmt.Println("      Ports 80 and 443 must be open and accessible from the internet.")
	fmt.Print("Domain (or 'localhost' for development): ")

	reader := bufio.NewReader(os.Stdin)
	domain, err := reader.ReadString('\n')
	if err != nil {
		fmt.Printf("Error reading domain: %v\n", err)
		fmt.Println("Using default: localhost (Let's Encrypt will not work, use self-signed certs)")
		return "localhost"
	}

	domain = strings.TrimSpace(domain)
	if domain == "" {
		fmt.Println("Domain cannot be empty. Using default: localhost")
		return "localhost"
	}

	// Warn if using localhost
	if domain == "localhost" || domain == "127.0.0.1" {
		fmt.Println("Warning: Using localhost. Let's Encrypt will not work.")
		fmt.Println("         The server will attempt to get certificates but will fail.")
		fmt.Println("         For production, use a real domain name.")
	}

	// Save domain to file
	if err := os.MkdirAll(certsDir, 0700); err == nil {
		domainFile := filepath.Join(certsDir, "domain.txt")
		if err := os.WriteFile(domainFile, []byte(domain), 0600); err == nil {
			fmt.Printf("Domain saved to: %s\n", domainFile)
		}
	}

	return domain
}

