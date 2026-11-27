package session

import "testing"

func TestStartKeepsExistingSessionsActive(t *testing.T) {
	m := NewManager("127.0.0.1")
	first, err := m.Start(PlatformQQ)
	if err != nil {
		t.Fatal(err)
	}
	m.MarkReady(first.ID)

	second, err := m.Start(PlatformWeChat)
	if err != nil {
		t.Fatal(err)
	}

	for _, want := range []struct {
		id     string
		status Status
	}{
		{id: first.ID, status: StatusReady},
		{id: second.ID, status: StatusWaiting},
	} {
		got, ok := m.Get(want.id)
		if !ok {
			t.Fatalf("session %s not found", want.id)
		}
		if got.Status != want.status {
			t.Fatalf("session %s status = %s, want %s", want.id, got.Status, want.status)
		}
	}
	if ids := m.ActiveIDs(); len(ids) != 2 {
		t.Fatalf("active IDs = %v, want two concurrent sessions", ids)
	}
}

func TestStartSetPortAndStopPreservesResults(t *testing.T) {
	m := NewManager("127.0.0.1")
	s, err := m.Start(PlatformQQ)
	if err != nil {
		t.Fatal(err)
	}
	if s.Port != 0 {
		t.Fatalf("initial port = %d, want 0", s.Port)
	}

	s, err = m.SetPort(s.ID, 5447)
	if err != nil {
		t.Fatal(err)
	}
	if s.Port != 5447 {
		t.Fatalf("port = %d, want 5447", s.Port)
	}

	if _, first := m.CaptureCode(s.ID, "test-code", "test", "https://example.test/?code=test-code"); !first {
		t.Fatal("expected first code capture")
	}
	if !m.CaptureFriends(s.ID, []Friend{{GID: 123, Name: "friend"}}) {
		t.Fatal("expected friend capture")
	}

	stopped, err := m.Stop(s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stopped.Status != StatusStopped || stopped.Port != 5447 || stopped.Code != "test-code" || len(stopped.Friends) != 1 {
		t.Fatalf("stopped session lost results: %+v", stopped)
	}

	again, err := m.Stop(s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if again.Status != StatusStopped || again.Code != "test-code" {
		t.Fatalf("idempotent stop changed results: %+v", again)
	}
	if len(m.ActiveIDs()) != 0 {
		t.Fatalf("stopped session still active: %v", m.ActiveIDs())
	}
}

func TestActiveIDsIncludesCaptured(t *testing.T) {
	m := NewManager("127.0.0.1")
	s, err := m.Start(PlatformWeChat)
	if err != nil {
		t.Fatal(err)
	}
	if _, first := m.CaptureCode(s.ID, "code", "test", ""); !first {
		t.Fatal("expected code capture")
	}
	ids := m.ActiveIDs()
	if len(ids) != 1 || ids[0] != s.ID {
		t.Fatalf("active IDs = %v, want [%s]", ids, s.ID)
	}
}

func TestSetPortRejectsStoppedSession(t *testing.T) {
	m := NewManager("127.0.0.1")
	s, err := m.Start(PlatformYYB)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Stop(s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetPort(s.ID, 5447); err == nil {
		t.Fatal("expected SetPort to reject stopped session")
	}
}
