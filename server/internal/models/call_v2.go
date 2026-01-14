package models

import "time"

// CallStatusV2 is the lifecycle state of a v2 call room.
// Keep values stable because they are part of the public API.
type CallStatusV2 string

const (
	CallStatusV2Waiting CallStatusV2 = "waiting"
	CallStatusV2Active  CallStatusV2 = "active"
	CallStatusV2Ended   CallStatusV2 = "ended"
)

type CallParticipantV2 struct {
	PeerID    string    `json:"peer_id"`
	JoinedAt  time.Time `json:"joined_at"`
	LeftAt    time.Time `json:"left_at,omitempty"`
	IsPresent bool      `json:"is_present"`
}

type CallV2 struct {
	ID        string            `json:"call_id"`
	Status    CallStatusV2      `json:"status"`
	CreatedAt time.Time         `json:"created_at"`
	UpdatedAt time.Time         `json:"updated_at"`
	ExpiresAt time.Time         `json:"expires_at"`
	Host      CallParticipantV2 `json:"-"`
	Guest     CallParticipantV2 `json:"-"`
}

func (c *CallV2) ParticipantsCount() int {
	count := 0
	if c.Host.IsPresent {
		count++
	}
	if c.Guest.IsPresent {
		count++
	}
	return count
}
