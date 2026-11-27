package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"farm-capture/internal/config"
	"farm-capture/internal/model"
	"farm-capture/internal/repo"
	"time"
)

type Service struct {
	store *repo.Store
	redis *config.Redis
	ttl   time.Duration
}

func NewService(store *repo.Store, redis *config.Redis) *Service {
	return &Service{store: store, redis: redis, ttl: 7 * 24 * time.Hour}
}

func (s *Service) Login(ctx context.Context, username, password string) (string, *model.User, error) {
	user, err := s.store.FindUserByName(username)
	if err != nil {
		return "", nil, errors.New("用户名或密码错误")
	}
	if !model.CheckPassword(user.Password, password) {
		return "", nil, errors.New("用户名或密码错误")
	}
	token, err := randomToken()
	if err != nil {
		return "", nil, err
	}
	if err := s.redis.SetToken(ctx, token, user.ID, s.ttl); err != nil {
		return "", nil, err
	}
	return token, user, nil
}

func (s *Service) Logout(ctx context.Context, token string) error {
	return s.redis.DeleteToken(ctx, token)
}

func (s *Service) ResolveUser(ctx context.Context, token string) (*model.User, error) {
	if token == "" {
		return nil, errors.New("unauthorized")
	}
	uid, err := s.redis.GetTokenUserID(ctx, token)
	if err != nil {
		return nil, errors.New("unauthorized")
	}
	var user model.User
	if err := s.store.DB.First(&user, uid).Error; err != nil {
		return nil, errors.New("unauthorized")
	}
	return &user, nil
}

func randomToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
