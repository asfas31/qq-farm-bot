package config

import (
	"farm-capture/internal/model"
	"fmt"
	"log"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// MySQLConfig MySQL 连接配置
type MySQLConfig struct {
	Host     string
	Port     int
	User     string
	Password string
	Database string
	DSN      string // 非空时优先使用完整 DSN
}

func (c MySQLConfig) BuildDSN() string {
	if c.DSN != "" {
		return c.DSN
	}
	return fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?charset=utf8mb4&parseTime=True&loc=Local",
		c.User, c.Password, c.Host, c.Port, c.Database)
}

func defaultMySQLConfig() MySQLConfig {
	return MySQLConfig{
		Host:     envStr("MYSQL_HOST", "127.0.0.1"),
		Port:     envInt("MYSQL_PORT", 3306),
		User:     envStr("MYSQL_USER", "root"),
		Password: envStr("MYSQL_PASSWORD", "root"),
		Database: envStr("MYSQL_DATABASE", "farm_capture"),
		DSN:      envStr("MYSQL_DSN", ""),
	}
}

// OpenMySQL 连接 MySQL 并自动迁移表结构
func OpenMySQL(cfg MySQLConfig) (*gorm.DB, error) {
	dsn := cfg.BuildDSN()
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		return nil, err
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(20)
	sqlDB.SetMaxIdleConns(5)
	sqlDB.SetConnMaxLifetime(time.Hour)

	if err := db.AutoMigrate(
		&model.User{},
		&model.Account{},
		&model.AccountConfig{},
		&model.BotLog{},
	); err != nil {
		return nil, err
	}

	seedAdmin(db)
	log.Printf("[mysql] connected %s:%d/%s", cfg.Host, cfg.Port, cfg.Database)
	return db, nil
}

func seedAdmin(db *gorm.DB) {
	var count int64
	db.Model(&model.User{}).Count(&count)
	if count > 0 {
		return
	}
	admin := model.User{
		Username: "admin",
		Password: model.HashPassword("admin"),
		Role:     "admin",
	}
	if err := db.Create(&admin).Error; err != nil {
		log.Printf("[mysql] seed admin failed: %v", err)
		return
	}
	log.Printf("[mysql] seeded default admin/admin")
}
