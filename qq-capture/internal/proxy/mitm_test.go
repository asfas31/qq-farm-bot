package proxy

import (
	"net"
	"strconv"
	"testing"

	"farm-capture/internal/cert"
	"farm-capture/internal/session"
)

func testCA(t *testing.T) *cert.CA {
	t.Helper()
	ca, err := cert.LoadOrCreate(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return ca
}

func reservePortRange(t *testing.T, count int) (int, []net.Listener) {
	t.Helper()
	for attempt := 0; attempt < 100; attempt++ {
		first, err := net.Listen("tcp", "0.0.0.0:0")
		if err != nil {
			t.Fatal(err)
		}
		base := first.Addr().(*net.TCPAddr).Port
		listeners := []net.Listener{first}
		ok := base+count-1 <= 65535
		for port := base + 1; ok && port < base+count; port++ {
			ln, listenErr := net.Listen("tcp", net.JoinHostPort("0.0.0.0", strconv.Itoa(port)))
			if listenErr != nil {
				ok = false
				break
			}
			listeners = append(listeners, ln)
		}
		if ok {
			return base, listeners
		}
		for _, ln := range listeners {
			_ = ln.Close()
		}
	}
	t.Fatal("could not reserve a contiguous port range")
	return 0, nil
}

func TestStartSkipsOccupiedPortAndStopReleasesSynchronously(t *testing.T) {
	base, reserved := reservePortRange(t, 2)
	_ = reserved[1].Close()
	defer reserved[0].Close()

	manager := session.NewManager("127.0.0.1")
	s, err := manager.Start(session.PlatformQQ)
	if err != nil {
		t.Fatal(err)
	}
	server := newServer(testCA(t), manager, base, 2)
	started, err := server.StartForSession(s)
	if err != nil {
		t.Fatal(err)
	}
	if started.Port != base+1 {
		t.Fatalf("selected port = %d, want %d", started.Port, base+1)
	}
	if err := server.Stop(s.ID); err != nil {
		t.Fatal(err)
	}

	ln, err := net.Listen("tcp", net.JoinHostPort("0.0.0.0", strconv.Itoa(base+1)))
	if err != nil {
		t.Fatalf("port was not released when Stop returned: %v", err)
	}
	_ = ln.Close()
	if err := server.Stop(s.ID); err != nil {
		t.Fatalf("second Stop failed: %v", err)
	}
}

func TestLowestPortIsReusedAfterStop(t *testing.T) {
	base, reserved := reservePortRange(t, 1)
	_ = reserved[0].Close()

	manager := session.NewManager("127.0.0.1")
	server := newServer(testCA(t), manager, base, 1)
	first, _ := manager.Start(session.PlatformQQ)
	startedFirst, err := server.StartForSession(first)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.Stop(first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Stop(first.ID); err != nil {
		t.Fatal(err)
	}

	second, _ := manager.Start(session.PlatformQQ)
	startedSecond, err := server.StartForSession(second)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Stop(second.ID)
	if startedFirst.Port != base || startedSecond.Port != base {
		t.Fatalf("ports = %d then %d, want %d both times", startedFirst.Port, startedSecond.Port, base)
	}
}

func TestCloseAllReleasesEveryProxyAndIsIdempotent(t *testing.T) {
	base, reserved := reservePortRange(t, 2)
	for _, ln := range reserved {
		_ = ln.Close()
	}

	manager := session.NewManager("127.0.0.1")
	server := newServer(testCA(t), manager, base, 2)
	first, err := manager.Start(session.PlatformQQ)
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.Start(session.PlatformWeChat)
	if err != nil {
		t.Fatal(err)
	}

	startedFirst, err := server.StartForSession(first)
	if err != nil {
		t.Fatal(err)
	}
	startedSecond, err := server.StartForSession(second)
	if err != nil {
		t.Fatal(err)
	}
	if startedFirst.Port == startedSecond.Port {
		t.Fatalf("concurrent proxies selected the same port %d", startedFirst.Port)
	}

	if err := server.CloseAll(); err != nil {
		t.Fatal(err)
	}
	if len(server.servers) != 0 {
		t.Fatalf("CloseAll left running servers: %d", len(server.servers))
	}
	if err := server.CloseAll(); err != nil {
		t.Fatalf("second CloseAll failed: %v", err)
	}
	if err := server.StopAll(); err != nil {
		t.Fatalf("StopAll after CloseAll failed: %v", err)
	}

	for _, port := range []int{startedFirst.Port, startedSecond.Port} {
		ln, err := net.Listen("tcp", net.JoinHostPort("0.0.0.0", strconv.Itoa(port)))
		if err != nil {
			t.Fatalf("port %d was not released when CloseAll returned: %v", port, err)
		}
		_ = ln.Close()
	}
}

func TestStartFailsWhenRangeIsOccupied(t *testing.T) {
	base, reserved := reservePortRange(t, 2)
	defer func() {
		for _, ln := range reserved {
			_ = ln.Close()
		}
	}()

	manager := session.NewManager("127.0.0.1")
	s, _ := manager.Start(session.PlatformQQ)
	server := newServer(testCA(t), manager, base, 2)
	if _, err := server.StartForSession(s); err == nil {
		t.Fatal("expected occupied range to fail")
	}
	if len(server.servers) != 0 {
		t.Fatalf("failed start left running servers: %d", len(server.servers))
	}
}
