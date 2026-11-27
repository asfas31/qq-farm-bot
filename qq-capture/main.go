package main

import (
	"context"
	"farm-capture/internal/cert"
	"farm-capture/internal/config"
	"farm-capture/internal/handler"
	"farm-capture/internal/middleware"
	"farm-capture/internal/proxy"
	"farm-capture/internal/session"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

func main() {
	cfg := config.Load()

	localIPs := handler.DetectLocalIPs()
	publicHost := handler.PickPublicHost(cfg.PublicHost, localIPs)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	ca, err := cert.LoadOrCreate(cfg.CertDir)
	if err != nil {
		log.Fatalf("load ca: %v", err)
	}

	manager := session.NewManager(publicHost)
	proxySrv := proxy.New(ca, manager, cfg.ProxyBasePort)
	h := handler.New(manager, proxySrv, ca, cfg.HTTPPort, publicHost, localIPs, cfg)

	gin.SetMode(gin.DebugMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(middleware.CORS())
	r.Use(middleware.RequestLogger())
	h.Register(r)

	addr := fmt.Sprintf("0.0.0.0:%d", cfg.HTTPPort)
	log.Printf("farm-capture Go gateway http://%s:%d", publicHost, cfg.HTTPPort)
	if len(localIPs) > 0 {
		log.Printf("local IPs: %s", strings.Join(localIPs, ", "))
	}
	log.Printf("mode: capture page only (no database)")
	log.Printf("MITM proxy base port: %d", cfg.ProxyBasePort)
	log.Printf("CA cert: http://%s:%d/api/cert", publicHost, cfg.HTTPPort)
	log.Printf("mobile hotspot fallback: http://192.168.137.1:%d", cfg.HTTPPort)

	httpSrv := &http.Server{Addr: addr, Handler: r}
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- httpSrv.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if closeErr := proxySrv.CloseAll(); closeErr != nil {
			log.Printf("close proxies: %v", closeErr)
		}
		if err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	case <-ctx.Done():
		log.Printf("shutdown signal received")
		if err := proxySrv.CloseAll(); err != nil {
			log.Printf("close proxies: %v", err)
		}

		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := httpSrv.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown: %v", err)
			_ = httpSrv.Close()
		}
		if err := <-serveErr; err != nil && err != http.ErrServerClosed {
			log.Printf("http server stopped: %v", err)
		}
	}
}
