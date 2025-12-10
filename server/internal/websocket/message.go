package websocket

import "encoding/json"

// EncodeMessage encodes a Message to JSON bytes
func EncodeMessage(msg Message) ([]byte, error) {
	return json.Marshal(msg)
}

