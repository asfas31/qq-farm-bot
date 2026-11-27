package proxy

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"farm-capture/internal/capture"
	"farm-capture/internal/cert"
	"farm-capture/internal/session"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/elazarl/goproxy"
)

type runningServer struct {
	server   *http.Server
	listener net.Listener
	port     int
}

type Server struct {
	ca        *cert.CA
	manager   *session.Manager
	basePort  int
	portCount int
	servers   map[string]*runningServer
	mu        sync.Mutex
	diag      sync.Map
}

type sessionDiag struct {
	sawFarmUI  bool
	sawGateObt bool
	warned     bool
}

func New(ca *cert.CA, manager *session.Manager, basePort int) *Server {
	return newServer(ca, manager, basePort, 100)
}

func newServer(ca *cert.CA, manager *session.Manager, basePort, portCount int) *Server {
	return &Server{
		ca:        ca,
		manager:   manager,
		basePort:  basePort,
		portCount: portCount,
		servers:   make(map[string]*runningServer),
	}
}

func (p *Server) StartForSession(s *session.Session) (*session.Session, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if _, exists := p.servers[s.ID]; exists {
		log.Printf("[proxy] session %s already running", s.ID[:8])
		current, ok := p.manager.Get(s.ID)
		if !ok {
			return nil, fmt.Errorf("session %s not found", s.ID)
		}
		return current, nil
	}

	proxy := goproxy.NewProxyHttpServer()
	proxy.Verbose = true
	proxy.Tr = &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}

	goproxyCa, err := tls.X509KeyPair(p.ca.CertPEM, p.ca.KeyPEM)
	if err != nil {
		log.Printf("[proxy] load CA key pair failed: %v", err)
		return nil, err
	}
	goproxyCa.Leaf, err = x509.ParseCertificate(goproxyCa.Certificate[0])
	if err != nil {
		log.Printf("[proxy] parse CA cert failed: %v", err)
		return nil, err
	}
	goproxy.GoproxyCa = goproxyCa

	sessionID := s.ID
	platform := s.Platform
	shortID := sessionID[:8]
	serverHost := s.Host

	shouldBypass := func(host string) bool {
		h, _, _ := net.SplitHostPort(host)
		if h == "" {
			h = host
		}

		if h == serverHost || h == "127.0.0.1" || h == "localhost" {
			return true
		}

		ips, _ := net.LookupIP(serverHost)
		hostIPs, _ := net.LookupIP(h)
		for _, sip := range ips {
			for _, hip := range hostIPs {
				if sip.Equal(hip) {
					return true
				}
			}
		}
		return false
	}

	proxy.OnRequest().HandleConnectFunc(func(host string, ctx *goproxy.ProxyCtx) (*goproxy.ConnectAction, string) {
		if shouldBypass(host) {
			return goproxy.OkConnect, host
		}
		if p.shouldBlockFarmConnect(platform, sessionID, host) {
			log.Printf("[proxy][%s] rejecting CONNECT to %s after code captured", shortID, host)
			return goproxy.RejectConnect, host
		}
		return goproxy.MitmConnect, host
	})

	proxy.OnRequest().DoFunc(func(r *http.Request, ctx *goproxy.ProxyCtx) (*http.Request, *http.Response) {
		host := r.Host
		if host == "" && r.URL != nil {
			host = r.URL.Host
		}

		if shouldBypass(host) {
			return r, nil
		}

		log.Printf("[proxy][%s] >>> %s %s host=%s", shortID, r.Method, r.URL.String(), host)

		p.manager.MarkReady(sessionID)
		p.noteRequestHost(platform, sessionID, shortID, host)

		if p.shouldBlockFarmRequest(platform, sessionID, r) {
			log.Printf("[proxy][%s] blocking farm request after wx/wechat capture url=%s", shortID, r.URL.String())
			return r, p.blockFarmResponse(r)
		}

		result := capture.ExtractFromRequest(r)
		if platform == session.PlatformQQ && !capture.IsFarmGateRequest(r) {
			result = capture.Result{URL: r.URL.String(), Method: r.Method}
		}
		if result.Matched {
			if result.Code != "" {
				log.Printf("[proxy][%s] *** CODE FOUND source=%s code=%s url=%s",
					shortID, result.Source, maskCode(result.Code), result.URL)

				isWxFarm := capture.IsWxFarmRequest(r) || capture.IsWxFarmURL(result.URL)
				if isWxFarm && platform == session.PlatformQQ {
					log.Printf("[proxy][%s] WARNING: wx farm code on qq session, auto-blocking", shortID)
				}

				got, first := p.manager.CaptureCode(sessionID, result.Code, result.Source, result.URL)
				if first && (got == session.PlatformWeChat || got == session.PlatformYYB || isWxFarm) {
					log.Printf("[proxy][%s] blocking wx/wechat request after capture", shortID)
					return r, p.blockFarmResponse(r)
				}
				if first {
					log.Printf("[proxy][%s] qq mode: pass through after capture", shortID)
				}
			} else {
				log.Printf("[proxy][%s] farm request matched but no code yet: %s", shortID, result.URL)
			}
		}

		return r, nil
	})

	proxy.OnResponse().DoFunc(func(resp *http.Response, ctx *goproxy.ProxyCtx) *http.Response {
		if resp == nil || resp.Request == nil {
			return resp
		}

		req := resp.Request
		log.Printf("[proxy][%s] <<< %d %s %s",
			shortID, resp.StatusCode, req.Method, req.URL.String())

		host := req.Host
		if host == "" && req.URL != nil {
			host = req.URL.Host
		}

		if platform == session.PlatformQQ && isFarmGameHost(host) && isWebSocketHandshake(resp.Header) {
			if rw, ok := resp.Body.(io.ReadWriter); ok {
				log.Printf("[proxy][%s] WS inspect attached url=%s", shortID, req.URL.String())
				resp.Body = newWSInspectReadWriter(rw, func(payload []byte) {
					p.inspectFriendPayload(sessionID, shortID, payload, req.URL.String())
				})
			} else {
				log.Printf("[proxy][%s] WS upgrade but body is not ReadWriter url=%s", shortID, req.URL.String())
			}
			return resp
		}

		if (platform == session.PlatformWeChat || platform == session.PlatformYYB) && isFarmGameHost(host) && isWebSocketHandshake(resp.Header) {
			if rw, ok := resp.Body.(io.ReadWriter); ok {
				log.Printf("[proxy][%s] wechat WS inspect attached url=%s", shortID, req.URL.String())
				resp.Body = newWSInspectReadWriter(rw, func(payload []byte) {
					p.inspectFriendPayload(sessionID, shortID, payload, req.URL.String())
				})
			}
			return resp
		}

		if resp.Body != nil && resp.ContentLength != 0 {
			body, err := io.ReadAll(resp.Body)
			if err == nil {
				resp.Body.Close()
				resp.Body = io.NopCloser(bytes.NewReader(body))
				if platform == session.PlatformQQ {
					p.inspectFriendPayload(sessionID, shortID, body, req.URL.String())
				}
				if platform == session.PlatformWeChat || platform == session.PlatformYYB {
					p.inspectWechatResponse(sessionID, shortID, req, body)
				}
			}
		}

		return resp
	})

	if p.basePort < 1 || p.portCount < 1 || p.basePort+p.portCount-1 > 65535 {
		return nil, fmt.Errorf("无效的代理端口范围 %d-%d", p.basePort, p.basePort+p.portCount-1)
	}

	var listener net.Listener
	var addr string
	var port int
	for candidate := p.basePort; candidate < p.basePort+p.portCount; candidate++ {
		candidateAddr := net.JoinHostPort("0.0.0.0", strconv.Itoa(candidate))
		candidateListener, listenErr := net.Listen("tcp", candidateAddr)
		if listenErr != nil {
			continue
		}
		listener = candidateListener
		addr = candidateAddr
		port = candidate
		break
	}
	if listener == nil {
		return nil, fmt.Errorf("代理端口范围 %d-%d 均不可用", p.basePort, p.basePort+p.portCount-1)
	}

	updated, err := p.manager.SetPort(s.ID, port)
	if err != nil {
		_ = listener.Close()
		return nil, err
	}

	srv := &http.Server{Handler: proxy}
	p.servers[s.ID] = &runningServer{server: srv, listener: listener, port: port}

	go func() {
		log.Printf("[proxy][%s] listening on %s (platform=%s)", shortID, addr, platform)
		if err := srv.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("[proxy][%s] server error: %v", shortID, err)
		} else {
			log.Printf("[proxy][%s] server stopped", shortID)
		}
	}()

	return updated, nil
}

func (p *Server) Stop(sessionID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stopLocked(sessionID)
}

func (p *Server) stopLocked(sessionID string) error {
	running, ok := p.servers[sessionID]
	if !ok {
		return nil
	}
	log.Printf("[proxy] stopping session %s port=%d", sessionID[:8], running.port)
	serverErr := running.server.Close()
	listenerErr := running.listener.Close()
	delete(p.servers, sessionID)
	p.diag.Delete(sessionID)
	if serverErr != nil && !errors.Is(serverErr, http.ErrServerClosed) {
		return serverErr
	}
	if listenerErr != nil && !errors.Is(listenerErr, net.ErrClosed) {
		return listenerErr
	}
	return nil
}

// StopAll closes every running session proxy. It is safe to call repeatedly.
func (p *Server) StopAll() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	var errs []error
	for sessionID := range p.servers {
		if err := p.stopLocked(sessionID); err != nil {
			errs = append(errs, fmt.Errorf("stop proxy session %s: %w", sessionID, err))
		}
	}
	return errors.Join(errs...)
}

// CloseAll is an alias for StopAll for process shutdown callers.
func (p *Server) CloseAll() error {
	return p.StopAll()
}

func (p *Server) noteRequestHost(platform session.Platform, sessionID, shortID, host string) {
	if platform != session.PlatformWeChat && platform != session.PlatformYYB {
		return
	}

	h := strings.ToLower(host)
	if idx := strings.Index(h, ":"); idx >= 0 {
		h = h[:idx]
	}

	d := p.getDiag(sessionID)
	changed := false
	if capture.IsWechatFarmUIHost(h) && !d.sawFarmUI {
		d.sawFarmUI = true
		changed = true
		log.Printf("[proxy][%s] detected wechat farm UI traffic host=%s", shortID, h)
	}
	if isFarmGameHost(h) && !d.sawGateObt {
		d.sawGateObt = true
		changed = true
		log.Printf("[proxy][%s] detected gate-obt traffic host=%s", shortID, h)
	}
	if changed {
		p.diag.Store(sessionID, d)
	}
	if d.sawFarmUI && !d.sawGateObt && !d.warned {
		d.warned = true
		p.diag.Store(sessionID, d)
		p.manager.WarnOnce(sessionID, "已检测到微信农场界面，但游戏连接走加密通道(mmtls)，当前 WiFi 代理无法抓到 Code。请改用 QQ 小程序抓包。")
	}
}

func (p *Server) getDiag(sessionID string) sessionDiag {
	if v, ok := p.diag.Load(sessionID); ok {
		if d, ok := v.(sessionDiag); ok {
			return d
		}
	}
	return sessionDiag{}
}

func (p *Server) inspectWechatResponse(sessionID, shortID string, req *http.Request, body []byte) {
	if req == nil {
		return
	}
	p.inspectFriendPayload(sessionID, shortID, body, req.URL.String())

	if code := capture.ExtractCodeFromBytes(body); code != "" {
		log.Printf("[proxy][%s] *** CODE FOUND source=body code=%s url=%s",
			shortID, maskCode(code), req.URL.String())
		got, first := p.manager.CaptureCode(sessionID, code, "body", req.URL.String())
		if first && (got == session.PlatformWeChat || got == session.PlatformYYB) {
			log.Printf("[proxy][%s] wechat body capture complete", shortID)
		}
	}
}

func (p *Server) shouldBlockFarmConnect(platform session.Platform, sessionID, host string) bool {
	if !isFarmGameHost(host) {
		return false
	}
	s, ok := p.manager.Get(sessionID)
	return ok && s.Code != "" && (platform == session.PlatformWeChat || platform == session.PlatformYYB || p.sessionHasWxCapture(s))
}

func (p *Server) shouldBlockFarmRequest(platform session.Platform, sessionID string, r *http.Request) bool {
	if !capture.IsFarmGateRequest(r) {
		return false
	}
	s, ok := p.manager.Get(sessionID)
	if !ok || s.Code == "" {
		return false
	}
	if platform == session.PlatformWeChat || platform == session.PlatformYYB {
		return true
	}
	return capture.IsWxFarmRequest(r) || p.sessionHasWxCapture(s)
}

func (p *Server) sessionHasWxCapture(s *session.Session) bool {
	if s == nil || s.Code == "" {
		return false
	}
	if s.Platform == session.PlatformWeChat || s.Platform == session.PlatformYYB {
		return true
	}
	return capture.IsWxFarmURL(s.CaptureURL)
}

func (p *Server) blockFarmResponse(r *http.Request) *http.Response {
	if isWebSocketHandshake(r.Header) {
		return goproxy.NewResponse(r, "text/plain", http.StatusBadGateway, "intercepted by farm-capture")
	}
	return goproxy.NewResponse(r, "application/json", http.StatusForbidden, `{"errmsg":"intercepted by farm-capture"}`)
}

func maskCode(code string) string {
	if len(code) <= 8 {
		return code
	}
	return code[:4] + "****" + code[len(code)-4:]
}

func isFarmGameHost(host string) bool {
	h := strings.ToLower(host)
	if idx := strings.Index(h, ":"); idx >= 0 {
		h = h[:idx]
	}
	return strings.Contains(h, "nqf.qq.com") ||
		strings.Contains(h, "gate-obt.nqf.qq.com")
}

func isWebSocketHandshake(header http.Header) bool {
	conn := strings.ToLower(strings.Join(header.Values("Connection"), ","))
	upgrade := strings.ToLower(strings.Join(header.Values("Upgrade"), ","))
	return strings.Contains(conn, "upgrade") && strings.Contains(upgrade, "websocket")
}

func (p *Server) inspectFriendPayload(sessionID, shortID string, body []byte, url string) {
	friends, ok := capture.ExtractFriendsFromPayload(body)
	if !ok || len(friends) == 0 {
		return
	}
	log.Printf("[proxy][%s] *** FRIENDS FOUND count=%d url=%s", shortID, len(friends), url)
	p.manager.CaptureFriends(sessionID, toSessionFriends(friends))
}

func toSessionFriends(records []capture.FriendRecord) []session.Friend {
	out := make([]session.Friend, 0, len(records))
	for _, record := range records {
		friend := session.Friend{
			GID:       record.GID,
			OpenID:    record.OpenID,
			Name:      record.Name,
			AvatarURL: record.AvatarURL,
			Level:     record.Level,
			Gold:      record.Gold,
		}
		if record.Plant != nil {
			friend.Plant = &session.PlantInfo{
				StealPlantNum: record.Plant.StealPlantNum,
				DryNum:        record.Plant.DryNum,
				WeedNum:       record.Plant.WeedNum,
				InsectNum:     record.Plant.InsectNum,
			}
		}
		out = append(out, friend)
	}
	return out
}
