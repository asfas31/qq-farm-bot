package session

import (
	"errors"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
)

type Platform string

const (
	PlatformQQ     Platform = "qq"
	PlatformWeChat Platform = "wechat"
	PlatformYYB    Platform = "yyb"
)

type Status string

const (
	StatusWaiting  Status = "waiting"
	StatusReady    Status = "ready"
	StatusCaptured Status = "captured"
	StatusStopped  Status = "stopped"
)

type PlantInfo struct {
	StealPlantNum uint32 `json:"steal_plant_num,omitempty"`
	DryNum        uint32 `json:"dry_num,omitempty"`
	WeedNum       uint32 `json:"weed_num,omitempty"`
	InsectNum     uint32 `json:"insect_num,omitempty"`
}

type Friend struct {
	GID       uint64     `json:"gid"`
	OpenID    string     `json:"open_id,omitempty"`
	Name      string     `json:"name,omitempty"`
	AvatarURL string     `json:"avatar_url,omitempty"`
	Level     uint32     `json:"level,omitempty"`
	Gold      uint64     `json:"gold,omitempty"`
	Plant     *PlantInfo `json:"plant,omitempty"`
}

type Session struct {
	ID         string    `json:"id"`
	Platform   Platform  `json:"platform"`
	Port       int       `json:"port"`
	Host       string    `json:"host"`
	Status     Status    `json:"status"`
	Code       string    `json:"code,omitempty"`
	CaptureURL string    `json:"-"`
	FriendGIDs []uint64  `json:"friendGids,omitempty"`
	Friends    []Friend  `json:"friends,omitempty"`
	Warned     bool      `json:"-"`
	CreatedAt  time.Time `json:"createdAt"`
}

type Event struct {
	Type    string   `json:"type"`
	Message string   `json:"message,omitempty"`
	Code    string   `json:"code,omitempty"`
	Status  Status   `json:"status,omitempty"`
	GIDs    []uint64 `json:"gids,omitempty"`
	Friends []Friend `json:"friends,omitempty"`
}

type Manager struct {
	mu             sync.RWMutex
	sessions       map[string]*Session
	publicHost     string
	subscribers    map[string]map[chan Event]struct{}
	onCodeCaptured func(*Session, string, string)
}

func NewManager(publicHost string) *Manager {
	return &Manager{
		sessions:    make(map[string]*Session),
		publicHost:  publicHost,
		subscribers: make(map[string]map[chan Event]struct{}),
	}
}

func (m *Manager) SetOnCodeCaptured(fn func(*Session, string, string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onCodeCaptured = fn
}

func (m *Manager) Start(platform Platform) (*Session, error) {
	if platform != PlatformQQ && platform != PlatformWeChat && platform != PlatformYYB {
		return nil, errors.New("platform must be qq, wechat or yyb")
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	id := uuid.New().String()

	s := &Session{
		ID:        id,
		Platform:  platform,
		Port:      0,
		Host:      m.publicHost,
		Status:    StatusWaiting,
		CreatedAt: time.Now(),
	}
	m.sessions[id] = s
	m.subscribers[id] = make(map[chan Event]struct{})

	m.broadcastLocked(id, Event{Type: "status", Status: StatusWaiting, Message: "等待手机连接代理..."})

	log.Printf("[session] created id=%s platform=%s", id[:8], platform)

	return cloneSession(s), nil
}

func (m *Manager) StopAllActive() []string {
	m.mu.Lock()
	defer m.mu.Unlock()

	var ids []string
	for id, s := range m.sessions {
		if s.Status == StatusWaiting || s.Status == StatusReady {
			s.Status = StatusStopped
			log.Printf("[session] stopped active session id=%s", id[:8])
			ids = append(ids, id)
		}
	}
	return ids
}

func (m *Manager) SetPort(id string, port int) (*Session, error) {
	if port < 1 || port > 65535 {
		return nil, errors.New("invalid proxy port")
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[id]
	if !ok {
		return nil, errors.New("session not found")
	}
	if s.Status == StatusStopped {
		return nil, errors.New("session already stopped")
	}
	if s.Port != 0 && s.Port != port {
		return nil, errors.New("session proxy port already set")
	}
	s.Port = port
	return cloneSession(s), nil
}

func (m *Manager) ActiveIDs() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	ids := make([]string, 0)
	for id, s := range m.sessions {
		if s.Status == StatusWaiting || s.Status == StatusReady || s.Status == StatusCaptured {
			ids = append(ids, id)
		}
	}
	return ids
}

func (m *Manager) Get(id string) (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[id]
	if !ok {
		return nil, false
	}
	return cloneSession(s), true
}

func (m *Manager) Active() (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, s := range m.sessions {
		if s.Status == StatusWaiting || s.Status == StatusReady {
			return cloneSession(s), true
		}
	}
	return nil, false
}

func (m *Manager) WarnOnce(id, message string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[id]
	if !ok || s.Status == StatusStopped || s.Code != "" {
		return
	}
	if s.Warned {
		return
	}
	s.Warned = true
	log.Printf("[session] id=%s warning: %s", id[:8], message)
	m.broadcastLocked(id, Event{Type: "warning", Message: message})
}

func (m *Manager) MarkReady(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok || s.Status == StatusStopped {
		return
	}
	if s.Status == StatusReady || s.Status == StatusCaptured {
		return
	}
	s.Status = StatusReady
	log.Printf("[session] id=%s status=ready (proxy connected)", id[:8])
	m.broadcastLocked(id, Event{Type: "status", Status: StatusReady, Message: "可以进农场了，正在等农场数据..."})
}

func (m *Manager) CaptureCode(id, code, source, url string) (Platform, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[id]
	if !ok || s.Status == StatusStopped {
		return "", false
	}
	if s.Code != "" {
		return s.Platform, false
	}

	s.Code = code
	if url != "" {
		s.CaptureURL = url
	}
	s.Status = StatusCaptured
	log.Printf("[session] id=%s captured code=%s source=%s url=%s", id[:8], maskCode(code), source, url)
	m.broadcastLocked(id, Event{
		Type:    "captured",
		Status:  StatusCaptured,
		Code:    code,
		Message: "已抓到 code，正在同步好友...",
	})
	if m.onCodeCaptured != nil {
		go m.onCodeCaptured(cloneSession(s), code, url)
	}
	return s.Platform, true
}

func (m *Manager) CaptureFriendGIDs(id string, gids []uint64) bool {
	if len(gids) == 0 {
		return false
	}

	friends := make([]Friend, 0, len(gids))
	for _, gid := range gids {
		if gid > 0 {
			friends = append(friends, Friend{GID: gid})
		}
	}
	return m.CaptureFriends(id, friends)
}

func (m *Manager) CaptureFriends(id string, friends []Friend) bool {
	if len(friends) == 0 {
		return false
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[id]
	if !ok || s.Status == StatusStopped {
		return false
	}

	merged := mergeFriends(s.Friends, friends)
	if len(merged) == len(s.Friends) && len(s.Friends) > 0 {
		same := true
		for i := range merged {
			if merged[i].GID != s.Friends[i].GID {
				same = false
				break
			}
		}
		if same {
			return false
		}
	}

	s.Friends = merged
	s.FriendGIDs = friendGIDsFromList(merged)
	log.Printf("[session] id=%s captured %d friends", id[:8], len(merged))
	m.broadcastLocked(id, Event{
		Type:    "friends",
		Message: "已提取好友列表",
		GIDs:    append([]uint64(nil), s.FriendGIDs...),
		Friends: cloneFriends(merged),
	})
	return true
}

func (m *Manager) Stop(id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[id]
	if !ok {
		return nil, errors.New("session not found")
	}
	if s.Status == StatusStopped {
		return cloneSession(s), nil
	}
	s.Status = StatusStopped
	log.Printf("[session] id=%s stopped", id[:8])
	m.broadcastLocked(id, Event{Type: "status", Status: StatusStopped, Message: "本次抓取已结束，代理端口已释放"})
	return cloneSession(s), nil
}

func (m *Manager) Subscribe(id string) (chan Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.sessions[id]; !ok {
		return nil, errors.New("session not found")
	}
	ch := make(chan Event, 16)
	m.subscribers[id][ch] = struct{}{}
	return ch, nil
}

func (m *Manager) Unsubscribe(id string, ch chan Event) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if subs, ok := m.subscribers[id]; ok {
		delete(subs, ch)
	}
	close(ch)
}

func (m *Manager) broadcast(id string, ev Event) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.broadcastLocked(id, ev)
}

func (m *Manager) broadcastLocked(id string, ev Event) {
	subs := m.subscribers[id]
	for ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

func cloneSession(s *Session) *Session {
	cp := *s
	if len(s.FriendGIDs) > 0 {
		cp.FriendGIDs = append([]uint64(nil), s.FriendGIDs...)
	}
	cp.Friends = cloneFriends(s.Friends)
	return &cp
}

func cloneFriends(list []Friend) []Friend {
	if len(list) == 0 {
		return nil
	}
	out := make([]Friend, len(list))
	copy(out, list)
	for i := range out {
		if list[i].Plant != nil {
			plant := *list[i].Plant
			out[i].Plant = &plant
		}
	}
	return out
}

func mergeFriends(existing, incoming []Friend) []Friend {
	byGID := make(map[uint64]Friend, len(existing)+len(incoming))
	order := make([]uint64, 0, len(existing)+len(incoming))

	for _, f := range existing {
		if f.GID == 0 {
			continue
		}
		if _, ok := byGID[f.GID]; !ok {
			order = append(order, f.GID)
		}
		byGID[f.GID] = f
	}
	for _, f := range incoming {
		if f.GID == 0 {
			continue
		}
		if prev, ok := byGID[f.GID]; ok {
			byGID[f.GID] = mergeFriend(prev, f)
			continue
		}
		order = append(order, f.GID)
		byGID[f.GID] = f
	}

	out := make([]Friend, 0, len(order))
	for _, gid := range order {
		out = append(out, byGID[gid])
	}
	return out
}

func mergeFriend(prev, next Friend) Friend {
	out := prev
	if next.OpenID != "" {
		out.OpenID = next.OpenID
	}
	if next.Name != "" {
		out.Name = next.Name
	}
	if next.AvatarURL != "" {
		out.AvatarURL = next.AvatarURL
	}
	if next.Level > 0 {
		out.Level = next.Level
	}
	if next.Gold > 0 {
		out.Gold = next.Gold
	}
	if next.Plant != nil {
		out.Plant = next.Plant
	}
	return out
}

func friendGIDsFromList(friends []Friend) []uint64 {
	gids := make([]uint64, 0, len(friends))
	for _, f := range friends {
		if f.GID > 0 {
			gids = append(gids, f.GID)
		}
	}
	return gids
}

func maskCode(code string) string {
	if len(code) <= 8 {
		return code
	}
	return code[:4] + "****" + code[len(code)-4:]
}
