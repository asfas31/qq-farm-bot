package handler

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
)

func findPanelDist() string {
	candidates := []string{
		filepath.Join("..", "capture-panel", "web", "dist"),
		filepath.Join("capture-panel", "web", "dist"),
	}
	for _, candidate := range candidates {
		indexPath := filepath.Join(candidate, "index.html")
		if info, err := os.Stat(indexPath); err == nil && !info.IsDir() {
			abs, err := filepath.Abs(candidate)
			if err == nil {
				return abs
			}
			return candidate
		}
	}
	return ""
}

func (h *Handler) registerPanelUI(r *gin.Engine, panelDist string) {
	assetsDir := filepath.Join(panelDist, "assets")
	if info, err := os.Stat(assetsDir); err == nil && info.IsDir() {
		r.Static("/assets", assetsDir)
	}
	r.GET("/", func(c *gin.Context) {
		h.servePanelIndex(c, panelDist)
	})
}

func (h *Handler) servePanelIndex(c *gin.Context, panelDist string) {
	data, err := os.ReadFile(filepath.Join(panelDist, "index.html"))
	if err != nil {
		c.String(http.StatusInternalServerError, "panel index not found")
		return
	}
	c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
	c.Data(http.StatusOK, "text/html; charset=utf-8", data)
}

func (h *Handler) registerCaptureAPI(r *gin.Engine) {
	r.GET("/api/health", h.health)
	r.GET("/api/addresses", h.addresses)
	r.GET("/api/cert", h.downloadCert)
	r.POST("/api/session/start", h.startSession)
	r.POST("/api/session/:id/stop", h.stopSession)
	r.GET("/api/session/:id", h.getSession)
	r.GET("/api/ws/:id", h.captureWS)

	capture := r.Group("/api/capture")
	{
		capture.GET("/health", h.health)
		capture.GET("/addresses", h.addresses)
		capture.GET("/cert", h.downloadCert)
		capture.POST("/session/start", h.startSession)
		capture.POST("/session/:id/stop", h.stopSession)
		capture.GET("/session/:id", h.getSession)
		capture.GET("/ws/:id", h.captureWS)
	}
}
