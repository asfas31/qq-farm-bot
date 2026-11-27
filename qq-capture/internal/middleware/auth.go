package middleware

import (
	"farm-capture/internal/auth"
	"farm-capture/internal/model"
	"net/http"

	"github.com/gin-gonic/gin"
)

func AuthRequired(authSvc *auth.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := c.GetHeader("x-admin-token")
		if token == "" {
			token = c.GetHeader("Authorization")
		}
		user, err := authSvc.ResolveUser(c.Request.Context(), token)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"ok": false, "error": "unauthorized"})
			return
		}
		c.Set("currentUser", user)
		c.Set("token", token)
		c.Next()
	}
}

func OptionalAuth(authSvc *auth.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := c.GetHeader("x-admin-token")
		if token == "" {
			c.Next()
			return
		}
		if user, err := authSvc.ResolveUser(c.Request.Context(), token); err == nil {
			c.Set("currentUser", user)
			c.Set("token", token)
		}
		c.Next()
	}
}

func CurrentUser(c *gin.Context) *model.User {
	if v, ok := c.Get("currentUser"); ok {
		if u, ok := v.(*model.User); ok {
			return u
		}
	}
	return nil
}
