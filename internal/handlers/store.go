package handlers

import (
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/tariel-x/gocall/internal/models"

	gonanoid "github.com/matoous/go-nanoid/v2"
)

var (
	ErrCallNotFound = errors.New("call not found")
	ErrCallFull     = errors.New("call already has two participants")
	ErrCallEnded    = errors.New("call already ended")
)

type CallStore struct {
	mu              sync.Mutex
	calls           map[string]*models.CallV2
	statusIndex     map[models.CallStatusV2]map[string]struct{}
	callTTL         time.Duration
	cleanupInterval time.Duration
}

func NewCallStore() *CallStore {
	s := &CallStore{
		calls: make(map[string]*models.CallV2),
		statusIndex: map[models.CallStatusV2]map[string]struct{}{
			models.CallStatusV2Waiting: {},
			models.CallStatusV2Active:  {},
		},
		callTTL:         30 * time.Minute,
		cleanupInterval: 3 * time.Hour,
	}
	go s.cleanupLoop()
	return s
}

func (s *CallStore) CreateCall(now time.Time) (*models.CallV2, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	id, err := gonanoid.New(16)
	if err != nil {
		return nil, err
	}

	call := &models.CallV2{
		ID:        id,
		Status:    models.CallStatusV2Waiting,
		CreatedAt: now,
		UpdatedAt: now,
		ExpiresAt: now.Add(s.callTTL),
		Host: models.CallParticipantV2{
			JoinedAt:       now,
			IsPresent:      true,
			ReconnectCount: 0,
		},
	}

	s.calls[id] = call
	s.syncStatusIndexLocked(id, models.CallStatusV2Waiting)
	return call, nil
}

func (s *CallStore) GetByID(callID string, now time.Time) (*models.CallV2, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	call, err := s.loadActiveCallLocked(callID, now)
	if err != nil {
		return nil, err
	}
	return call, nil
}

func (s *CallStore) ListByStatus(status models.CallStatusV2, limit int, now time.Time) ([]*models.CallV2, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.cleanupExpiredLocked(now)

	bucket, ok := s.statusIndex[status]
	if !ok || len(bucket) == 0 {
		return nil, nil
	}

	calls := make([]*models.CallV2, 0, len(bucket))
	for id := range bucket {
		if call, exists := s.calls[id]; exists {
			calls = append(calls, call)
		}
	}

	sort.Slice(calls, func(i, j int) bool {
		if calls[i].CreatedAt.Equal(calls[j].CreatedAt) {
			return calls[i].ID < calls[j].ID
		}
		return calls[i].CreatedAt.Before(calls[j].CreatedAt)
	})

	if limit > 0 && len(calls) > limit {
		calls = calls[:limit]
	}

	return calls, nil
}

func (s *CallStore) Join(callID string, now time.Time) (peerID string, call *models.CallV2, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	call, err = s.loadActiveCallLocked(callID, now)
	if err != nil {
		return "", nil, err
	}

	if call.ParticipantsCount() >= 2 {
		return "", call, ErrCallFull
	}

	id, err := gonanoid.New(16)
	if err != nil {
		return "", nil, err
	}

	call.Guest = models.CallParticipantV2{
		PeerID:         id,
		JoinedAt:       now,
		IsPresent:      true,
		ReconnectCount: 0,
	}
	call.Status = models.CallStatusV2Active
	call.UpdatedAt = now
	call.ExpiresAt = now.Add(s.callTTL)
	s.syncStatusIndexLocked(call.ID, call.Status)

	return id, call, nil
}

// EnsureHostPeerID assigns a peer_id for the host if it wasn't assigned yet.
// This keeps CreateCall response minimal (no peer_id) while allowing WS signaling.
func (s *CallStore) EnsureHostPeerID(callID string, now time.Time) (peerID string, call *models.CallV2, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	call, err = s.loadActiveCallLocked(callID, now)
	if err != nil {
		return "", nil, err
	}

	if call.Host.PeerID != "" {
		return call.Host.PeerID, call, nil
	}

	id, err := gonanoid.New(16)
	if err != nil {
		return "", nil, err
	}

	call.Host.PeerID = id
	call.Host.JoinedAt = now
	call.Host.IsPresent = true
	call.UpdatedAt = now
	call.ExpiresAt = now.Add(s.callTTL)

	return id, call, nil
}

type PeerRoleV2 string

const (
	PeerRoleV2Host  PeerRoleV2 = "host"
	PeerRoleV2Guest PeerRoleV2 = "guest"
)

func (s *CallStore) ValidatePeer(callID, peerID string, now time.Time) (role PeerRoleV2, call *models.CallV2, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	call, err = s.loadActiveCallLocked(callID, now)
	if err != nil {
		return "", nil, err
	}

	switch {
	case peerID != "" && peerID == call.Host.PeerID:
		wasPresent := call.Host.IsPresent
		call.Host.IsPresent = true
		if !wasPresent {
			call.Host.ReconnectCount++
		}
		call.Host.DisconnectedAt = time.Time{}
		call.UpdatedAt = now
		call.ExpiresAt = now.Add(s.callTTL)
		return PeerRoleV2Host, call, nil
	case peerID != "" && peerID == call.Guest.PeerID:
		wasPresent := call.Guest.IsPresent
		call.Guest.IsPresent = true
		if !wasPresent {
			call.Guest.ReconnectCount++
		}
		call.Guest.DisconnectedAt = time.Time{}
		call.UpdatedAt = now
		call.ExpiresAt = now.Add(s.callTTL)
		return PeerRoleV2Guest, call, nil
	default:
		return "", call, errors.New("invalid peer_id")
	}
}

// EndCall marks the call as ended. This is a minimal MVP implementation and does not
// attempt to authenticate who is allowed to end the call.
func (s *CallStore) EndCall(callID string, now time.Time) (*models.CallV2, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	call, exists := s.calls[callID]
	if !exists {
		return nil, ErrCallNotFound
	}

	s.markEndedLocked(call, now)
	snapshot := *call
	s.removeCallLocked(callID)

	return &snapshot, nil
}

// MarkPeerDisconnected flags peer presence as lost but keeps the call active to allow reconnection.
func (s *CallStore) MarkPeerDisconnected(callID, peerID string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()

	call, ok := s.calls[callID]
	if !ok {
		return
	}

	switch {
	case peerID == call.Host.PeerID:
		call.Host.IsPresent = false
		call.Host.DisconnectedAt = now
	case peerID == call.Guest.PeerID:
		call.Guest.IsPresent = false
		call.Guest.DisconnectedAt = now
	default:
		return
	}

	call.UpdatedAt = now
}

func (s *CallStore) loadActiveCallLocked(callID string, now time.Time) (*models.CallV2, error) {
	call, ok := s.calls[callID]
	if !ok {
		return nil, ErrCallNotFound
	}

	if call.Status == models.CallStatusV2Ended {
		s.removeCallLocked(callID)
		return nil, ErrCallEnded
	}

	if !call.ExpiresAt.IsZero() && now.After(call.ExpiresAt) {
		s.markEndedLocked(call, now)
		s.removeCallLocked(callID)
		return nil, ErrCallEnded
	}

	return call, nil
}

func (s *CallStore) cleanupLoop() {
	if s.cleanupInterval <= 0 {
		return
	}
	ticker := time.NewTicker(s.cleanupInterval)
	for range ticker.C {
		s.mu.Lock()
		s.cleanupExpiredLocked(time.Now())
		s.mu.Unlock()
	}
}

func (s *CallStore) cleanupExpiredLocked(now time.Time) {
	for id, call := range s.calls {
		if call.Status == models.CallStatusV2Ended {
			s.removeCallLocked(id)
			continue
		}
		if !call.ExpiresAt.IsZero() && now.After(call.ExpiresAt) {
			s.markEndedLocked(call, now)
			s.removeCallLocked(id)
		}
	}
}

func (s *CallStore) markEndedLocked(call *models.CallV2, now time.Time) {
	call.Status = models.CallStatusV2Ended
	call.UpdatedAt = now
	call.ExpiresAt = now
	call.Host.IsPresent = false
	call.Guest.IsPresent = false
}

func (s *CallStore) removeCallLocked(callID string) {
	delete(s.calls, callID)
	s.untrackStatusLocked(callID)
}

func (s *CallStore) syncStatusIndexLocked(callID string, status models.CallStatusV2) {
	s.untrackStatusLocked(callID)
	if bucket, ok := s.statusIndex[status]; ok {
		bucket[callID] = struct{}{}
	}
}

func (s *CallStore) untrackStatusLocked(callID string) {
	for _, bucket := range s.statusIndex {
		delete(bucket, callID)
	}
}
