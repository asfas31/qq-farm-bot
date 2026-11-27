package config

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// Redis Redis 客户端封装
type Redis struct {
	Client *redis.Client
}

// OpenRedis 连接 Redis
func OpenRedis(cfg RedisConfig) (*Redis, error) {
	client := redis.NewClient(&redis.Options{
		Addr:     cfg.Addr,
		Password: cfg.Password,
		DB:       cfg.DB,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		return nil, err
	}
	log.Printf("[redis] connected %s db=%d", cfg.Addr, cfg.DB)
	return &Redis{Client: client}, nil
}

func tokenKey(token string) string { return "farm:token:" + token }
func statusKey(accountID uint) string {
	return fmt.Sprintf("farm:status:%d", accountID)
}

func (r *Redis) SetToken(ctx context.Context, token string, userID uint, ttl time.Duration) error {
	return r.Client.Set(ctx, tokenKey(token), userID, ttl).Err()
}

func (r *Redis) GetTokenUserID(ctx context.Context, token string) (uint, error) {
	v, err := r.Client.Get(ctx, tokenKey(token)).Uint64()
	return uint(v), err
}

func (r *Redis) DeleteToken(ctx context.Context, token string) error {
	return r.Client.Del(ctx, tokenKey(token)).Err()
}

func (r *Redis) SetAccountStatus(ctx context.Context, accountID uint, status any) error {
	b, err := json.Marshal(status)
	if err != nil {
		return err
	}
	return r.Client.Set(ctx, statusKey(accountID), b, 24*time.Hour).Err()
}

func (r *Redis) GetAccountStatus(ctx context.Context, accountID uint, dest any) error {
	b, err := r.Client.Get(ctx, statusKey(accountID)).Bytes()
	if err != nil {
		return err
	}
	return json.Unmarshal(b, dest)
}

func (r *Redis) PublishLog(ctx context.Context, accountID uint, payload []byte) error {
	return r.Client.Publish(ctx, fmt.Sprintf("farm:logs:%d", accountID), payload).Err()
}

func (r *Redis) PublishLogAll(ctx context.Context, payload []byte) error {
	return r.Client.Publish(ctx, "farm:logs:all", payload).Err()
}

func (r *Redis) SubscribeLogs(ctx context.Context, accountID uint) *redis.PubSub {
	channel := "farm:logs:all"
	if accountID > 0 {
		channel = fmt.Sprintf("farm:logs:%d", accountID)
	}
	return r.Client.Subscribe(ctx, channel)
}
