package handlersv2

import (
	"errors"
	"testing"
	"time"

	"github.com/tariel-x/gocall/internal/models"
)

func TestCreateCallGeneratesUniqueIDs(t *testing.T) {
	store := NewCallStore()
	base := time.Unix(1_700_000_000, 0)

	first, err := store.CreateCall(base)
	if err != nil {
		t.Fatalf("first create call failed: %v", err)
	}
	second, err := store.CreateCall(base.Add(10 * time.Second))
	if err != nil {
		t.Fatalf("second create call failed: %v", err)
	}

	if first.ID == second.ID {
		t.Fatalf("expected unique call IDs, got duplicate %s", first.ID)
	}
}

func TestJoinIndependentCalls(t *testing.T) {
	store := NewCallStore()
	base := time.Unix(1_700_100_000, 0)

	callA, _ := store.CreateCall(base)
	callB, _ := store.CreateCall(base.Add(time.Second))

	guestA, callRefA, err := store.Join(callA.ID, base.Add(2*time.Second))
	if err != nil {
		t.Fatalf("join for call A failed: %v", err)
	}
	guestB, callRefB, err := store.Join(callB.ID, base.Add(3*time.Second))
	if err != nil {
		t.Fatalf("join for call B failed: %v", err)
	}

	if guestA == guestB {
		t.Fatalf("expected different guest IDs, got %s", guestA)
	}
	if callRefA.ID == callRefB.ID {
		t.Fatalf("unexpected same call reference for different joins")
	}
	if callRefA.Status != models.CallStatusV2Active {
		t.Fatalf("call A should be active, got %s", callRefA.Status)
	}
	if callRefB.Status != models.CallStatusV2Active {
		t.Fatalf("call B should be active, got %s", callRefB.Status)
	}
}

func TestListByStatusTracksUpdates(t *testing.T) {
	store := NewCallStore()
	base := time.Unix(1_700_200_000, 0)

	callA, _ := store.CreateCall(base)
	callB, _ := store.CreateCall(base.Add(time.Second))

	waiting, err := store.ListByStatus(models.CallStatusV2Waiting, 0, base.Add(2*time.Second))
	if err != nil {
		t.Fatalf("list waiting failed: %v", err)
	}
	if len(waiting) != 2 {
		t.Fatalf("expected 2 waiting calls, got %d", len(waiting))
	}

	if _, _, err := store.Join(callA.ID, base.Add(3*time.Second)); err != nil {
		t.Fatalf("join callA failed: %v", err)
	}

	waiting, err = store.ListByStatus(models.CallStatusV2Waiting, 0, base.Add(4*time.Second))
	if err != nil {
		t.Fatalf("list waiting after join failed: %v", err)
	}
	if len(waiting) != 1 || waiting[0].ID != callB.ID {
		t.Fatalf("expected only callB waiting, got %+v", waiting)
	}

	active, err := store.ListByStatus(models.CallStatusV2Active, 0, base.Add(4*time.Second))
	if err != nil {
		t.Fatalf("list active failed: %v", err)
	}
	if len(active) != 1 || active[0].ID != callA.ID {
		t.Fatalf("expected callA active, got %+v", active)
	}
}

func TestEndAndExpiryRemoveCall(t *testing.T) {
	store := NewCallStore()
	base := time.Unix(1_700_300_000, 0)

	call, _ := store.CreateCall(base)

	// Manual end removes the call
	if _, err := store.EndCall(call.ID, base.Add(time.Second)); err != nil {
		t.Fatalf("end call failed: %v", err)
	}
	if _, err := store.GetByID(call.ID, base.Add(2*time.Second)); !errors.Is(err, ErrCallNotFound) {
		t.Fatalf("expected ErrCallNotFound after end, got %v", err)
	}

	// Expiry after TTL
	store.callTTL = time.Millisecond
	call2Created := base.Add(3 * time.Second)
	call2, _ := store.CreateCall(call2Created)
	beforeExpiry := call2Created.Add(500 * time.Microsecond)
	if _, err := store.GetByID(call2.ID, beforeExpiry); err != nil {
		t.Fatalf("call2 should be available before TTL, got %v", err)
	}
	afterExpiry := call2Created.Add(2 * time.Millisecond)
	if _, err := store.GetByID(call2.ID, afterExpiry); !errors.Is(err, ErrCallEnded) {
		t.Fatalf("expected ErrCallEnded after ttl, got %v", err)
	}
}
