package repo

import (
	"encoding/json"
	"farm-capture/internal/model"

	"gorm.io/gorm"
)

type Store struct {
	DB *gorm.DB
}

func New(db *gorm.DB) *Store {
	return &Store{DB: db}
}

func (s *Store) FindUserByName(username string) (*model.User, error) {
	var u model.User
	if err := s.DB.Where("username = ?", username).First(&u).Error; err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) ListAccounts(username, role string) ([]model.Account, error) {
	var list []model.Account
	q := s.DB.Order("id desc")
	if role != "admin" && username != "" {
		q = q.Where("username = ?", username)
	}
	if err := q.Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

func (s *Store) GetAccount(id uint) (*model.Account, error) {
	var a model.Account
	if err := s.DB.First(&a, id).Error; err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) SaveAccount(a *model.Account) error {
	return s.DB.Save(a).Error
}

func (s *Store) CreateAccount(a *model.Account) error {
	if err := s.DB.Create(a).Error; err != nil {
		return err
	}
	cfg := model.AccountConfig{
		AccountID:        a.ID,
		PlantingStrategy: "max_exp",
		Automation:       model.DefaultAutomationJSON(),
		Intervals:        model.DefaultIntervalsJSON(),
	}
	return s.DB.Create(&cfg).Error
}

func (s *Store) DeleteAccount(id uint) error {
	s.DB.Where("account_id = ?", id).Delete(&model.AccountConfig{})
	return s.DB.Delete(&model.Account{}, id).Error
}

func (s *Store) GetAccountConfig(accountID uint) (*model.AccountConfig, error) {
	var cfg model.AccountConfig
	if err := s.DB.Where("account_id = ?", accountID).First(&cfg).Error; err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (s *Store) SaveAccountConfig(cfg *model.AccountConfig) error {
	return s.DB.Save(cfg).Error
}

func (s *Store) AddLog(accountID uint, tag, module, message string, isWarn bool) error {
	return s.DB.Create(&model.BotLog{
		AccountID: accountID,
		Tag:       tag,
		Module:    module,
		Message:   message,
		IsWarn:    isWarn,
	}).Error
}

func (s *Store) ListLogs(accountID uint, limit int) ([]model.BotLog, error) {
	if limit <= 0 {
		limit = 100
	}
	var logs []model.BotLog
	q := s.DB.Order("id desc").Limit(limit)
	if accountID > 0 {
		q = q.Where("account_id = ?", accountID)
	}
	if err := q.Find(&logs).Error; err != nil {
		return nil, err
	}
	return logs, nil
}

func ParseAutomation(raw []byte) model.AutomationConfig {
	var cfg model.AutomationConfig
	_ = json.Unmarshal(raw, &cfg)
	if cfg.Fertilizer == "" {
		cfg.Fertilizer = "smart"
	}
	return cfg
}
