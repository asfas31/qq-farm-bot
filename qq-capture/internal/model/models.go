package model

import (
	"time"

	"golang.org/x/crypto/bcrypt"
	"gorm.io/datatypes"
)

type User struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Username  string    `gorm:"uniqueIndex;size:64" json:"username"`
	Password  string    `gorm:"size:128" json:"-"`
	Role      string    `gorm:"size:16;default:user" json:"role"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Account struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Name      string    `gorm:"size:128" json:"name"`
	Code      string    `gorm:"type:text" json:"code,omitempty"`
	Platform  string    `gorm:"size:16;default:qq" json:"platform"`
	Uin       string    `gorm:"size:64" json:"uin,omitempty"`
	QQ        string    `gorm:"size:64" json:"qq,omitempty"`
	Avatar    string    `gorm:"size:512" json:"avatar,omitempty"`
	Username  string    `gorm:"size:64;index" json:"username,omitempty"`
	Running   bool      `gorm:"-" json:"running,omitempty"`
	Nick      string    `gorm:"-" json:"nick,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type AutomationConfig struct {
	Farm            bool   `json:"farm"`
	FarmPush        bool   `json:"farmPush"`
	Friend          bool   `json:"friend"`
	FriendSteal     bool   `json:"friendSteal"`
	FriendHelp      bool   `json:"friendHelp"`
	FriendBad       bool   `json:"friendBad"`
	Task            bool   `json:"task"`
	Sell            bool   `json:"sell"`
	Fertilizer      string `json:"fertilizer"`
	FertilizerMulti bool   `json:"fertilizerMultiSeason"`
}

type AccountConfig struct {
	ID               uint              `gorm:"primaryKey" json:"id"`
	AccountID        uint              `gorm:"uniqueIndex" json:"accountId"`
	PlantingStrategy string            `gorm:"size:32;default:max_exp" json:"plantingStrategy"`
	PreferredSeedID  int               `json:"preferredSeedId"`
	Automation       datatypes.JSON    `gorm:"type:json" json:"automation"`
	Intervals        datatypes.JSON    `gorm:"type:json" json:"intervals"`
	CreatedAt        time.Time         `json:"createdAt"`
	UpdatedAt        time.Time         `json:"updatedAt"`
}

type BotLog struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	AccountID uint      `gorm:"index" json:"accountId"`
	Tag       string    `gorm:"size:32" json:"tag"`
	Module    string    `gorm:"size:32" json:"module"`
	Message   string    `gorm:"type:text" json:"message"`
	IsWarn    bool      `json:"isWarn"`
	CreatedAt time.Time `gorm:"index" json:"createdAt"`
}

func HashPassword(raw string) string {
	b, err := bcrypt.GenerateFromPassword([]byte(raw), bcrypt.DefaultCost)
	if err != nil {
		return raw
	}
	return string(b)
}

func CheckPassword(hash, raw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(raw)) == nil
}

func DefaultAutomationJSON() datatypes.JSON {
	return datatypes.JSON([]byte(`{"farm":true,"farmPush":true,"friend":true,"friendSteal":true,"friendHelp":true,"friendBad":false,"task":true,"sell":true,"fertilizer":"smart","fertilizerMultiSeason":true}`))
}

func DefaultIntervalsJSON() datatypes.JSON {
	return datatypes.JSON([]byte(`{"farm":120,"farmMin":60,"farmMax":180,"stealMin":30,"stealMax":90,"helpMin":30,"helpMax":90}`))
}
