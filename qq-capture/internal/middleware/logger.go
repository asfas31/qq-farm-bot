package middleware

import (
	"log"
	"time"

	"github.com/gin-gonic/gin"
)

func RequestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		raw := c.Request.URL.RawQuery
		method := c.Request.Method
		clientIP := c.ClientIP()

		c.Next()

		status := c.Writer.Status()
		latency := time.Since(start)
		if raw != "" {
			path = path + "?" + raw
		}

		log.Printf("[HTTP] %s | %3d | %13v | %15s | %s",
			method, status, latency, clientIP, path)

		if len(c.Errors) > 0 {
			for _, e := range c.Errors {
				log.Printf("[HTTP] error: %v", e)
			}
		}
	}
}
