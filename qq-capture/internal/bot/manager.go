package bot

import (
	"context"
	"encoding/json"
	"farm-capture/internal/config"
	"farm-capture/internal/game"
	"farm-capture/internal/model"
	"farm-capture/internal/repo"
	"fmt"
	"log"
	"sync"
	"time"
)

type Manager struct {
	cfg     config.Config
	store   *repo.Store
	redis   *config.Redis
	workers map[uint]*Worker
	mu      sync.RWMutex
}

func NewManager(cfg config.Config, store *repo.Store, redis *config.Redis) *Manager {
	return &Manager{
		cfg:     cfg,
		store:   store,
		redis:   redis,
		workers: make(map[uint]*Worker),
	}
}

func (m *Manager) IsRunning(accountID uint) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	w, ok := m.workers[accountID]
	return ok && w.Running()
}

func (m *Manager) StartAccount(ctx context.Context, account *model.Account) error {
	if account.Code == "" {
		return fmt.Errorf("账号缺少 code")
	}
	m.mu.Lock()
	if old, ok := m.workers[account.ID]; ok {
		old.Stop()
		delete(m.workers, account.ID)
	}
	w := NewWorker(m.cfg, m.store, m.redis, account)
	m.workers[account.ID] = w
	m.mu.Unlock()
	go w.Run(ctx)
	return nil
}

func (m *Manager) StopAccount(accountID uint) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if w, ok := m.workers[accountID]; ok {
		w.Stop()
		delete(m.workers, accountID)
	}
}

func (m *Manager) Status(accountID uint) game.AccountStatus {
	m.mu.RLock()
	w, ok := m.workers[accountID]
	m.mu.RUnlock()
	if !ok {
		return game.AccountStatus{}
	}
	return w.ClientStatus()
}

func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, w := range m.workers {
		w.Stop()
		delete(m.workers, id)
	}
}

type Worker struct {
	cfg    config.Config
	store  *repo.Store
	redis  *config.Redis
	acc    *model.Account
	client *game.Client
	stopCh chan struct{}
	done   chan struct{}
	mu     sync.Mutex
}

func NewWorker(cfg config.Config, store *repo.Store, redis *config.Redis, acc *model.Account) *Worker {
	return &Worker{
		cfg:    cfg,
		store:  store,
		redis:  redis,
		acc:    acc,
		stopCh: make(chan struct{}),
		done:   make(chan struct{}),
	}
}

func (w *Worker) Running() bool {
	select {
	case <-w.done:
		return false
	default:
		return true
	}
}

func (w *Worker) ClientStatus() game.AccountStatus {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.client == nil {
		return game.AccountStatus{}
	}
	return w.client.Status()
}

func (w *Worker) Stop() {
	select {
	case <-w.stopCh:
	default:
		close(w.stopCh)
	}
	w.mu.Lock()
	if w.client != nil {
		_ = w.client.Close()
	}
	w.mu.Unlock()
}

func (w *Worker) Run(ctx context.Context) {
	defer close(w.done)
	w.pushLog("系统", "bot", "启动账号: "+w.acc.Name, false)

	gcfg := game.Config{
		WSURL:         w.cfg.GameWSURL,
		ClientVersion: w.cfg.GameVersion,
		Platform:      w.cfg.GamePlatform,
		OS:            w.cfg.GameOS,
	}
	client := game.NewClient(gcfg, w.acc.Code, w.acc.Platform)
	client.SetLogger(func(tag, msg string) {
		w.pushLog(tag, "game", msg, false)
	})

	if err := client.Connect(); err != nil {
		w.pushLog("错误", "game", "连接失败: "+err.Error(), true)
		_ = w.store.AddLog(w.acc.ID, "错误", "game", "连接失败: "+err.Error(), true)
		return
	}

	w.mu.Lock()
	w.client = client
	w.mu.Unlock()
	w.syncStatus(ctx)

	cfg, _ := w.store.GetAccountConfig(w.acc.ID)
	auto := model.AutomationConfig{Farm: true, Friend: true, FriendSteal: true}
	if cfg != nil {
		auto = repo.ParseAutomation(cfg.Automation)
	}

	farmTicker := time.NewTicker(2 * time.Minute)
	friendTicker := time.NewTicker(60 * time.Second)
	defer farmTicker.Stop()
	defer friendTicker.Stop()

	for {
		select {
		case <-w.stopCh:
			_ = client.Close()
			w.pushLog("系统", "bot", "账号已停止", false)
			return
		case <-farmTicker.C:
			if auto.Farm {
				w.pushLog("巡田", "farm", "执行农场巡检...", false)
			}
		case <-friendTicker.C:
			if auto.Friend && auto.FriendSteal {
				w.pushLog("偷菜", "friend", "执行好友偷菜巡检...", false)
				// TODO: 拉好友列表后逐个偷菜
			}
		case <-ctx.Done():
			_ = client.Close()
			return
		}
	}
}

func (w *Worker) syncStatus(ctx context.Context) {
	st := w.ClientStatus()
	_ = w.redis.SetAccountStatus(ctx, w.acc.ID, st)
	payload, _ := json.Marshal(map[string]any{
		"type":      "status:update",
		"accountId": w.acc.ID,
		"status":    st,
	})
	_ = w.redis.PublishLog(ctx, w.acc.ID, payload)
	_ = w.redis.PublishLogAll(ctx, payload)
}

func (w *Worker) pushLog(tag, module, message string, isWarn bool) {
	_ = w.store.AddLog(w.acc.ID, tag, module, message, isWarn)
	ctx := context.Background()
	payload, _ := json.Marshal(map[string]any{
		"type":      "log:new",
		"accountId": w.acc.ID,
		"tag":       tag,
		"module":    module,
		"message":   message,
		"isWarn":    isWarn,
		"ts":        time.Now().UnixMilli(),
	})
	_ = w.redis.PublishLog(ctx, w.acc.ID, payload)
	_ = w.redis.PublishLogAll(ctx, payload)
	log.Printf("[bot][%d] [%s] %s", w.acc.ID, tag, message)
}
