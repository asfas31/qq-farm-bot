package handler

import (
	"farm-capture/internal/capture"
	"farm-capture/internal/config"
	"farm-capture/internal/game"
	"farm-capture/internal/session"
	"log"
	"net/url"
	"time"
)

type gameDefaults struct {
	wsURL   string
	version string
	os      string
}

func (h *Handler) fetchFriendsAfterCode(s *session.Session, code, captureURL string) {
	if s == nil || code == "" {
		return
	}
	if _, loaded := h.fetching.LoadOrStore(s.ID, struct{}{}); loaded {
		return
	}
	defer h.fetching.Delete(s.ID)

	// 主动拉取只是加速路径，失败时必须保留代理会话，让手机 QQ 的被动好友响应继续进入解析器。
	// 不能在这里结束 session：手机端可能仍在登录，或者稍后才会请求好友列表。
	// Core 的 /stop 和 TTL 负责最终回收代理资源。

	// 始终执行主动获取，不依赖被动检测（云端环境被动检测不稳定）。
	// Code 刚出现时手机 QQ 可能还没有完成登录，重试几次可以避免用户被迫打开好友列表。
	cfg := buildGameConfig(s.Platform, captureURL, h.gameDefaults)
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		client := game.NewClient(cfg, code, gamePlatform(s.Platform))
		log.Printf("[fetch] session=%s connecting for friends platform=%s attempt=%d", s.ID[:8], s.Platform, attempt)
		if err := client.Connect(); err != nil {
			lastErr = err
			log.Printf("[fetch] session=%s connect failed attempt=%d: %v", s.ID[:8], attempt, err)
			_ = client.Close()
		} else {
			records, err := client.FetchFriends()
			_ = client.Close()
			if err != nil {
				lastErr = err
				log.Printf("[fetch] session=%s friends failed attempt=%d: %v", s.ID[:8], attempt, err)
			} else if len(records) > 0 {
				if h.manager.CaptureFriends(s.ID, friendRecordsToSession(records)) {
					log.Printf("[fetch] session=%s captured %d friends with code", s.ID[:8], len(records))
				}
				return
			}
		}
		if attempt < 3 {
			time.Sleep(2 * time.Second)
		}
	}
	if lastErr != nil {
		log.Printf("[fetch] session=%s friends unavailable after retries: %v; keeping proxy open", s.ID[:8], lastErr)
	} else {
		log.Printf("[fetch] session=%s friends empty after retries; keeping proxy open", s.ID[:8])
	}
}

func buildGameConfig(platform session.Platform, captureURL string, defaults gameDefaults) game.Config {
	cfg := game.Config{
		WSURL:         defaults.wsURL,
		ClientVersion: defaults.version,
		Platform:      gamePlatform(platform),
		OS:            defaults.os,
	}
	if captureURL == "" {
		return cfg
	}

	u, err := url.Parse(captureURL)
	if err != nil {
		return cfg
	}
	q := u.Query()
	if v := q.Get("platform"); v != "" {
		cfg.Platform = v
	}
	if v := q.Get("os"); v != "" {
		cfg.OS = v
	}
	if v := q.Get("ver"); v != "" {
		cfg.ClientVersion = v
	}
	return cfg
}

func gamePlatform(platform session.Platform) string {
	if platform == session.PlatformWeChat {
		return "wx"
	}
	return string(platform)
}

func friendRecordsToSession(records []capture.FriendRecord) []session.Friend {
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

func gameDefaultsFromConfig(cfg config.Config) gameDefaults {
	return gameDefaults{
		wsURL:   cfg.GameWSURL,
		version: cfg.GameVersion,
		os:      cfg.GameOS,
	}
}
