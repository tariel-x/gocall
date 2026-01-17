package turn

import (
	"crypto/rand"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pion/turn/v3"
)

type TURNServer struct {
	server   *turn.Server
	username string
	password string

	logger *slog.Logger
}

type Credentials struct {
	Username string
	Password string
}

func Initialize(port int, realm string, logger *slog.Logger) (*TURNServer, error) {
	// Create UDP listener
	udpListener, err := net.ListenPacket("udp4", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		return nil, fmt.Errorf("failed to create UDP listener: %w", err)
	}

	// Load or generate credentials
	creds := loadOrGenerateCredentials(logger)

	// Get public IP address for relay
	publicIP := getPublicIP(logger)
	if publicIP == nil {
		logger.Info(fmt.Sprintf("Warning: Could not determine public IP, using local IP detection"))
		publicIP = getLocalIP(logger)
	}
	logger.Info(fmt.Sprintf("TURN server will use relay address: %s", publicIP.String()))

	// Create TURN server
	s, err := turn.NewServer(turn.ServerConfig{
		Realm:       realm,
		AuthHandler: simpleAuthHandler(creds.Username, creds.Password),
		PacketConnConfigs: []turn.PacketConnConfig{
			{
				PacketConn: udpListener,
				RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
					RelayAddress: publicIP,  // Use public IP for relay
					Address:      "0.0.0.0", // Listen on all interfaces
				},
			},
		},
	})

	if err != nil {
		return nil, fmt.Errorf("failed to create TURN server: %w", err)
	}

	logger.Info(fmt.Sprintf("TURN server initialized on port %d", port))
	logger.Info(fmt.Sprintf("TURN credentials - Username: %s, Password: %s", creds.Username, creds.Password))

	return &TURNServer{
		server:   s,
		username: creds.Username,
		password: creds.Password,

		logger: logger,
	}, nil
}

func (ts *TURNServer) GetCredentials() Credentials {
	return Credentials{
		Username: ts.username,
		Password: ts.password,
	}
}

func loadOrGenerateCredentials(logger *slog.Logger) Credentials {
	keysDir := getKeysDirectory()
	usernameFile := filepath.Join(keysDir, "turn-username.key")
	passwordFile := filepath.Join(keysDir, "turn-password.key")

	// Try to load existing credentials
	if usernameData, err := os.ReadFile(usernameFile); err == nil {
		if passwordData, err := os.ReadFile(passwordFile); err == nil {
			return Credentials{
				Username: string(usernameData),
				Password: string(passwordData),
			}
		}
	}

	// Generate new credentials
	username := "familycall"
	password := generatePassword()

	// Save credentials
	if err := os.MkdirAll(keysDir, 0700); err == nil {
		os.WriteFile(usernameFile, []byte(username), 0600)
		os.WriteFile(passwordFile, []byte(password), 0600)
		logger.Info(fmt.Sprintf("TURN credentials saved to: %s", keysDir))
	}

	return Credentials{
		Username: username,
		Password: password,
	}
}

func getKeysDirectory() string {
	execPath, err := os.Executable()
	if err != nil {
		return "keys"
	}
	execDir := filepath.Dir(execPath)
	return filepath.Join(execDir, "keys")
}

func (ts *TURNServer) Close() error {
	if ts.server != nil {
		return ts.server.Close()
	}
	return nil
}

func simpleAuthHandler(expectedUsername, expectedPassword string) turn.AuthHandler {
	return func(username string, realm string, srcAddr net.Addr) ([]byte, bool) {
		if username == expectedUsername {
			return turn.GenerateAuthKey(username, realm, expectedPassword), true
		}
		return nil, false
	}
}

func generatePassword() string {
	b := make([]byte, 16)
	rand.Read(b)
	return fmt.Sprintf("%x", b)
}

// getPublicIP gets the public IP address from ipify.org
func getPublicIP(logger *slog.Logger) net.IP {
	client := &http.Client{
		Timeout: 5 * time.Second,
	}

	resp, err := client.Get("https://api.ipify.org")
	if err != nil {
		logger.Error("Failed to get public IP from ipify.org", "error", err)
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		logger.Error(fmt.Sprintf("ipify.org returned status: %d", resp.StatusCode))
		return nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		logger.Error("Failed to read response from ipify.org", "error", err)
		return nil
	}

	ipStr := string(body)
	ipStr = strings.TrimSpace(ipStr)

	ip := net.ParseIP(ipStr)
	if ip == nil {
		logger.Info(fmt.Sprintf("Invalid IP address from ipify.org: %s", ipStr))
		return nil
	}

	logger.Info(fmt.Sprintf("Detected public IP: %s", ip.String()))
	return ip
}

// getLocalIP gets the local IP address for fallback
func getLocalIP(logger *slog.Logger) net.IP {
	// Try to connect to a remote address to determine local IP
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		logger.Error("Failed to determine local IP", "error", err)
		return net.ParseIP("127.0.0.1")
	}
	defer conn.Close()

	localAddr := conn.LocalAddr().(*net.UDPAddr)
	logger.Info(fmt.Sprintf("Detected local IP: %s", localAddr.IP.String()))
	return localAddr.IP
}
