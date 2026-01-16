package turn

import (
	"crypto/rand"
	"fmt"
	"io"
	"log"
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
}

type Credentials struct {
	Username string
	Password string
}

func Initialize(port int, realm string) (*TURNServer, error) {
	// Create UDP listener
	udpListener, err := net.ListenPacket("udp4", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		return nil, fmt.Errorf("failed to create UDP listener: %w", err)
	}

	// Load or generate credentials
	creds := loadOrGenerateCredentials()
	
	// Get public IP address for relay
	publicIP := getPublicIP()
	if publicIP == nil {
		log.Printf("Warning: Could not determine public IP, using local IP detection")
		publicIP = getLocalIP()
	}
	log.Printf("TURN server will use relay address: %s", publicIP.String())
	
	// Create TURN server
	s, err := turn.NewServer(turn.ServerConfig{
		Realm:       realm,
		AuthHandler: simpleAuthHandler(creds.Username, creds.Password),
		PacketConnConfigs: []turn.PacketConnConfig{
			{
				PacketConn: udpListener,
				RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
					RelayAddress: publicIP, // Use public IP for relay
					Address:      "0.0.0.0", // Listen on all interfaces
				},
			},
		},
	})

	if err != nil {
		return nil, fmt.Errorf("failed to create TURN server: %w", err)
	}

	log.Printf("TURN server initialized on port %d", port)
	log.Printf("TURN credentials - Username: %s, Password: %s", creds.Username, creds.Password)

	return &TURNServer{
		server:   s,
		username: creds.Username,
		password: creds.Password,
	}, nil
}

func (ts *TURNServer) GetCredentials() Credentials {
	return Credentials{
		Username: ts.username,
		Password: ts.password,
	}
}

func loadOrGenerateCredentials() Credentials {
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
		log.Printf("TURN credentials saved to: %s", keysDir)
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
func getPublicIP() net.IP {
	client := &http.Client{
		Timeout: 5 * time.Second,
	}
	
	resp, err := client.Get("https://api.ipify.org")
	if err != nil {
		log.Printf("Failed to get public IP from ipify.org: %v", err)
		return nil
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != 200 {
		log.Printf("ipify.org returned status: %d", resp.StatusCode)
		return nil
	}
	
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("Failed to read response from ipify.org: %v", err)
		return nil
	}
	
	ipStr := string(body)
	ipStr = strings.TrimSpace(ipStr)
	
	ip := net.ParseIP(ipStr)
	if ip == nil {
		log.Printf("Invalid IP address from ipify.org: %s", ipStr)
		return nil
	}
	
	log.Printf("Detected public IP: %s", ip.String())
	return ip
}

// getLocalIP gets the local IP address for fallback
func getLocalIP() net.IP {
	// Try to connect to a remote address to determine local IP
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		log.Printf("Failed to determine local IP: %v", err)
		return net.ParseIP("127.0.0.1")
	}
	defer conn.Close()
	
	localAddr := conn.LocalAddr().(*net.UDPAddr)
	log.Printf("Detected local IP: %s", localAddr.IP.String())
	return localAddr.IP
}

