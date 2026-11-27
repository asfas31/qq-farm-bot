package handler

import (
	"embed"
	"farm-capture/internal/cert"
	"farm-capture/internal/config"
	"farm-capture/internal/proxy"
	"farm-capture/internal/session"
	"io/fs"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

//go:embed web/*
var webFS embed.FS

var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

type Handler struct {
	manager      *session.Manager
	proxy        *proxy.Server
	ca           *cert.CA
	httpPort     int
	localIPs     []string
	publicHost   string
	gameDefaults gameDefaults
	fetching     sync.Map
	lifecycleMu  sync.Mutex
}

func New(manager *session.Manager, proxySrv *proxy.Server, ca *cert.CA, httpPort int, publicHost string, localIPs []string, cfg config.Config) *Handler {
	h := &Handler{
		manager:      manager,
		proxy:        proxySrv,
		ca:           ca,
		httpPort:     httpPort,
		localIPs:     localIPs,
		publicHost:   publicHost,
		gameDefaults: gameDefaultsFromConfig(cfg),
	}
	manager.SetOnCodeCaptured(h.onCodeCaptured)
	return h
}

func (h *Handler) onCodeCaptured(s *session.Session, code, captureURL string) {
	log.Printf("[handler] captured code platform=%s session=%s, fetching friends", s.Platform, s.ID[:8])
	go h.fetchFriendsAfterCode(s, code, captureURL)
}

func (h *Handler) Register(r *gin.Engine) {
	h.registerCaptureAPI(r)

	if panelDist := findPanelDist(); panelDist != "" {
		log.Printf("[handler] capture-panel UI enabled: %s", panelDist)
		h.registerPanelUI(r, panelDist)
		return
	}

	webRoot, _ := fs.Sub(webFS, "web")
	r.StaticFS("/assets", http.FS(webRoot))
	r.GET("/", h.serveIndex)
	log.Printf("[handler] using built-in capture HTML (capture-panel dist not found)")
}

func (h *Handler) serveIndex(c *gin.Context) {
	data, err := webFS.ReadFile("web/index.html")
	if err != nil {
		c.String(http.StatusInternalServerError, "page not found")
		return
	}
	c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
	c.Data(http.StatusOK, "text/html; charset=utf-8", data)
}

func (h *Handler) health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"ok": true, "service": "farm-capture-go", "mode": "capture-only",
		"time": time.Now().Format(time.RFC3339),
	})
}

func (h *Handler) downloadCert(c *gin.Context) {
	c.Header("Content-Disposition", `attachment; filename="farm-capture-ca.crt"`)
	c.Data(http.StatusOK, "application/x-x509-ca-cert", h.ca.CertPEM)
}

type startReq struct {
	Platform string `json:"platform" binding:"required"`
}

func validPlatform(platform session.Platform) bool {
	return platform == session.PlatformQQ || platform == session.PlatformWeChat || platform == session.PlatformYYB
}

func (h *Handler) finishSession(id string) (*session.Session, error) {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	return h.finishSessionLocked(id)
}

func (h *Handler) finishSessionLocked(id string) (*session.Session, error) {
	proxyErr := h.proxy.Stop(id)
	s, sessionErr := h.manager.Stop(id)
	if proxyErr != nil {
		log.Printf("[handler] stop proxy session=%s error: %v", id, proxyErr)
		if sessionErr == nil {
			return s, proxyErr
		}
	}
	return s, sessionErr
}

func (h *Handler) startSession(c *gin.Context) {
	var req startReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "platform 必填"})
		return
	}
	platform := session.Platform(req.Platform)
	if !validPlatform(platform) {
		c.JSON(http.StatusConflict, gin.H{"error": "platform must be qq, wechat or yyb"})
		return
	}

	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()

	s, err := h.manager.Start(platform)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	started, err := h.proxy.StartForSession(s)
	if err != nil {
		_ = h.proxy.Stop(s.ID)
		_, _ = h.manager.Stop(s.ID)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"session": started, "certUrl": "/api/cert"})
}

func (h *Handler) stopSession(c *gin.Context) {
	s, err := h.finishSession(c.Param("id"))
	if err != nil {
		if s == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "session": s})
		return
	}
	c.JSON(http.StatusOK, gin.H{"session": s})
}

func (h *Handler) getSession(c *gin.Context) {
	s, ok := h.manager.Get(c.Param("id"))
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"session": s})
}

func (h *Handler) captureWS(c *gin.Context) {
	id := c.Param("id")
	ch, err := h.manager.Subscribe(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	defer h.manager.Unsubscribe(id, ch)
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	if s, ok := h.manager.Get(id); ok {
		ev := session.Event{Type: "session", Status: s.Status, Code: s.Code, Message: "已连接"}
		if len(s.FriendGIDs) > 0 {
			ev.GIDs = append([]uint64(nil), s.FriendGIDs...)
		}
		if len(s.Friends) > 0 {
			ev.Friends = s.Friends
		}
		_ = conn.WriteJSON(ev)
	}
	for ev := range ch {
		if err := conn.WriteJSON(ev); err != nil {
			return
		}
	}
}
