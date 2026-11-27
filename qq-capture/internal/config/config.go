package config

import (
	"log"
	"os"
	"path/filepath"
	"strconv"

	"gopkg.in/yaml.v3"
)

type Config struct {
	HTTPPort      int
	ProxyBasePort int
	PublicHost    string
	CertDir       string
	MySQL         MySQLConfig
	Redis         RedisConfig
	JWTSecret     string
	GameWSURL     string
	GameVersion   string
	GamePlatform  string
	GameOS       string
	WasmPath     string
	// qq-farm-bot 主项目对接（抓到好友 gid 后自动推送）
	BotURL       string
	BotToken     string
	BotAccountID string
}

// RedisConfig Redis 连接配置
type RedisConfig struct {
	Addr     string
	Password string
	DB       int
}

type fileConfig struct {
	Server struct {
		HTTPPort      int    `yaml:"http_port"`
		ProxyBasePort int    `yaml:"proxy_base_port"`
		PublicHost    string `yaml:"public_host"`
	} `yaml:"server"`
	CertDir string `yaml:"cert_dir"`
}

func Load() Config {
	cfg := defaults()
	loadYAML(&cfg)
	applyEnv(&cfg)
	return cfg
}

func defaults() Config {
	return Config{
		HTTPPort:      8080,
		ProxyBasePort: 5447,
		PublicHost:    "",
		CertDir:       "./certs",
		MySQL:         defaultMySQLConfig(),
		Redis: RedisConfig{
			Addr:     "127.0.0.1:6379",
			Password: "",
			DB:       0,
		},
		JWTSecret:    "farm-capture-secret-change-me",
		GameWSURL:    "wss://gate-obt.nqf.qq.com/prod/ws",
		GameVersion:  "1.11.6.24_20260601",
		GamePlatform: "qq",
		GameOS:       "Windows",
		WasmPath:     filepath.Join("..", "qq-farm-bot-core", "core", "src", "utils", "tsdk.wasm"),
	}
}

func loadYAML(cfg *Config) {
	path := envStr("CONFIG_PATH", "config.yaml")
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[config] read %s failed: %v", path, err)
		}
		return
	}

	var fc fileConfig
	if err := yaml.Unmarshal(data, &fc); err != nil {
		log.Printf("[config] parse %s failed: %v", path, err)
		return
	}

	if fc.Server.HTTPPort > 0 {
		cfg.HTTPPort = fc.Server.HTTPPort
	}
	if fc.Server.ProxyBasePort > 0 {
		cfg.ProxyBasePort = fc.Server.ProxyBasePort
	}
	if fc.Server.PublicHost != "" {
		cfg.PublicHost = fc.Server.PublicHost
	}
	if fc.CertDir != "" {
		cfg.CertDir = fc.CertDir
	}

	log.Printf("[config] loaded %s", path)
}

func applyEnv(cfg *Config) {
	if v := envStr("HTTP_PORT", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.HTTPPort = n
		}
	}
	if v := envStr("PROXY_BASE_PORT", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.ProxyBasePort = n
		}
	}
	if v := envStr("PUBLIC_HOST", ""); v != "" {
		cfg.PublicHost = v
	}
	if v := envStr("CERT_DIR", ""); v != "" {
		cfg.CertDir = v
	}
}

func envStr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	if v := os.Getenv(key); v != "" {
		b, err := strconv.ParseBool(v)
		if err == nil {
			return b
		}
	}
	return fallback
}
