package handler

import (
	"bytes"
	"encoding/json"
	"farm-capture/internal/cert"
	"farm-capture/internal/config"
	"farm-capture/internal/proxy"
	"farm-capture/internal/session"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestStartSessionKeepsExistingSessionActive(t *testing.T) {
	gin.SetMode(gin.TestMode)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	basePort := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()

	ca, err := cert.LoadOrCreate(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager("127.0.0.1")
	proxySrv := proxy.New(ca, manager, basePort)
	t.Cleanup(func() {
		if err := proxySrv.CloseAll(); err != nil {
			t.Errorf("CloseAll: %v", err)
		}
	})
	h := New(manager, proxySrv, ca, 0, "127.0.0.1", nil, config.Config{})
	router := gin.New()
	router.POST("/start", h.startSession)

	start := func(platform string) *session.Session {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost, "/start", bytes.NewBufferString(`{"platform":"`+platform+`"}`))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("start %s status = %d, body = %s", platform, response.Code, response.Body.String())
		}
		var body struct {
			Session *session.Session `json:"session"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Session == nil {
			t.Fatalf("start %s returned no session", platform)
		}
		return body.Session
	}

	first := start("qq")
	second := start("wechat")

	currentFirst, ok := manager.Get(first.ID)
	if !ok {
		t.Fatalf("first session %s not found", first.ID)
	}
	if currentFirst.Status != session.StatusWaiting {
		t.Fatalf("first session status = %s, want %s", currentFirst.Status, session.StatusWaiting)
	}
	if first.Port == second.Port {
		t.Fatalf("concurrent sessions selected the same port %d", first.Port)
	}
	if ids := manager.ActiveIDs(); len(ids) != 2 {
		t.Fatalf("active IDs = %v, want two concurrent sessions", ids)
	}
}
