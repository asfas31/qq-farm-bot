package handler

import (
	"context"
	"encoding/json"
	"farm-capture/internal/auth"
	"farm-capture/internal/bot"
	"farm-capture/internal/config"
	"farm-capture/internal/model"
	"farm-capture/internal/repo"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

type API struct {
	store   *repo.Store
	auth    *auth.Service
	bots    *bot.Manager
	redis   *config.Redis
}

func NewAPI(store *repo.Store, authSvc *auth.Service, bots *bot.Manager, redis *config.Redis) *API {
	return &API{store: store, auth: authSvc, bots: bots, redis: redis}
}

func (a *API) Register(r *gin.RouterGroup, authMW gin.HandlerFunc) {
	r.POST("/login", a.login)
	r.GET("/ping", a.ping)
	r.GET("/game-version", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true, "clientVersion": "1.11.6.24_20260601"})
	})

	authed := r.Group("")
	authed.Use(authMW)
	{
		authed.POST("/logout", a.logout)
		authed.GET("/user/me", a.me)
		authed.GET("/auth/validate", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"valid": true}}) })

		authed.GET("/accounts", a.listAccounts)
		authed.POST("/accounts", a.saveAccount)
		authed.DELETE("/accounts/:id", a.deleteAccount)
		authed.POST("/accounts/:id/start", a.startAccount)
		authed.POST("/accounts/:id/stop", a.stopAccount)

		authed.GET("/settings", a.getSettings)
		authed.POST("/settings/save", a.saveSettings)
		authed.GET("/status", a.getStatus)
		authed.GET("/logs", a.getLogs)
		authed.POST("/automation", a.saveAutomation)
	}
}

func (a *API) login(c *gin.Context) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid body"})
		return
	}
	token, user, err := a.auth.Login(c.Request.Context(), req.Username, req.Password)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{
		"token": token,
		"role":  user.Role,
		"user":  user,
	}})
}

func (a *API) logout(c *gin.Context) {
	if token, ok := c.Get("token"); ok {
		_ = a.auth.Logout(c.Request.Context(), token.(string))
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (a *API) me(c *gin.Context) {
	user := currentUser(c)
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{
		"username": user.Username,
		"role":     user.Role,
	}})
}

func (a *API) ping(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"ok": true}})
}

func (a *API) listAccounts(c *gin.Context) {
	user := currentUser(c)
	list, err := a.store.ListAccounts(user.Username, user.Role)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	for i := range list {
		list[i].Running = a.bots.IsRunning(list[i].ID)
		st := a.bots.Status(list[i].ID)
		if st.Name != "" {
			list[i].Nick = st.Name
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"accounts": list, "nextId": len(list) + 1}})
}

func (a *API) saveAccount(c *gin.Context) {
	user := currentUser(c)
	var req struct {
		ID       uint   `json:"id"`
		Name     string `json:"name"`
		Code     string `json:"code"`
		Platform string `json:"platform"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid body"})
		return
	}
	if req.Platform == "" {
		req.Platform = "qq"
	}
	if req.Platform == "wechat" {
		req.Platform = "wx"
	}

	if req.ID > 0 {
		acc, err := a.store.GetAccount(req.ID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "account not found"})
			return
		}
		if req.Name != "" {
			acc.Name = req.Name
		}
		if req.Code != "" {
			acc.Code = req.Code
		}
		if req.Platform != "" {
			acc.Platform = req.Platform
		}
		if err := a.store.SaveAccount(acc); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
			return
		}
		if req.Code != "" {
			a.bots.StopAccount(acc.ID)
			_ = a.bots.StartAccount(context.Background(), acc)
		}
		list, _ := a.store.ListAccounts(user.Username, user.Role)
		c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"accounts": list}})
		return
	}

	acc := &model.Account{
		Name:     req.Name,
		Code:     req.Code,
		Platform: req.Platform,
		Username: user.Username,
	}
	if acc.Name == "" {
		suffix := req.Code
		if len(suffix) > 8 {
			suffix = suffix[:8]
		}
		acc.Name = "账号-" + suffix
	}
	if err := a.store.CreateAccount(acc); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	_ = a.bots.StartAccount(context.Background(), acc)
	list, _ := a.store.ListAccounts(user.Username, user.Role)
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"accounts": list}})
}

func (a *API) deleteAccount(c *gin.Context) {
	user := currentUser(c)
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	a.bots.StopAccount(uint(id))
	if err := a.store.DeleteAccount(uint(id)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	list, _ := a.store.ListAccounts(user.Username, user.Role)
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"accounts": list}})
}

func (a *API) startAccount(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	acc, err := a.store.GetAccount(uint(id))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "account not found"})
		return
	}
	if err := a.bots.StartAccount(c.Request.Context(), acc); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"ok": true}})
}

func (a *API) stopAccount(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	a.bots.StopAccount(uint(id))
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"ok": true}})
}

func (a *API) getSettings(c *gin.Context) {
	accountID := headerAccountID(c)
	cfg, err := a.store.GetAccountConfig(accountID)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"ok": true, "data": defaultSettings()})
		return
	}
	var auto map[string]any
	var intervals map[string]any
	_ = json.Unmarshal(cfg.Automation, &auto)
	_ = json.Unmarshal(cfg.Intervals, &intervals)
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{
		"plantingStrategy": cfg.PlantingStrategy,
		"preferredSeedId":  cfg.PreferredSeedID,
		"automation":       auto,
		"intervals":        intervals,
	}})
}

func (a *API) saveSettings(c *gin.Context) {
	accountID := headerAccountID(c)
	var body map[string]any
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid body"})
		return
	}
	cfg, err := a.store.GetAccountConfig(accountID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "config not found"})
		return
	}
	if v, ok := body["plantingStrategy"].(string); ok {
		cfg.PlantingStrategy = v
	}
	if auto, ok := body["automation"]; ok {
		b, _ := json.Marshal(auto)
		cfg.Automation = b
	}
	if intervals, ok := body["intervals"]; ok {
		b, _ := json.Marshal(intervals)
		cfg.Intervals = b
	}
	if err := a.store.SaveAccountConfig(cfg); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": body})
}

func (a *API) saveAutomation(c *gin.Context) {
	accountID := headerAccountID(c)
	var body map[string]any
	_ = c.ShouldBindJSON(&body)
	cfg, err := a.store.GetAccountConfig(accountID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "config not found"})
		return
	}
	var auto map[string]any
	_ = json.Unmarshal(cfg.Automation, &auto)
	for k, v := range body {
		auto[k] = v
	}
	b, _ := json.Marshal(auto)
	cfg.Automation = b
	_ = a.store.SaveAccountConfig(cfg)
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"automation": auto}})
}

func (a *API) getStatus(c *gin.Context) {
	accountID := headerAccountID(c)
	st := a.bots.Status(accountID)
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": st})
}

func (a *API) getLogs(c *gin.Context) {
	accountID := headerAccountID(c)
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "100"))
	logs, err := a.store.ListLogs(accountID, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": logs})
}

func (a *API) CreateFromCapture(name, code, platform, username string) (*model.Account, error) {
	if platform == "wechat" {
		platform = "wx"
	}
	acc := &model.Account{Name: name, Code: code, Platform: platform, Username: username}
	if err := a.store.CreateAccount(acc); err != nil {
		return nil, err
	}
	_ = a.bots.StartAccount(context.Background(), acc)
	return acc, nil
}

func currentUser(c *gin.Context) *model.User {
	if v, ok := c.Get("currentUser"); ok {
		if u, ok := v.(*model.User); ok {
			return u
		}
	}
	return &model.User{Username: "admin", Role: "admin"}
}

func headerAccountID(c *gin.Context) uint {
	if v := c.GetHeader("x-account-id"); v != "" {
		id, _ := strconv.ParseUint(v, 10, 64)
		return uint(id)
	}
	return 0
}

func defaultSettings() gin.H {
	return gin.H{
		"plantingStrategy": "max_exp",
		"preferredSeedId":    0,
		"automation": gin.H{
			"farm": true, "friend": true, "friendSteal": true, "friendHelp": true,
		},
		"intervals": gin.H{"farm": 120, "stealMin": 30, "stealMax": 90},
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
