package capture

import (
	"net/http"
	"net/url"
	"strings"
)

func IsFarmGateRequest(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	return IsFarmGateURL(r.URL.String(), r.Host)
}

func IsFarmGateURL(rawURL, host string) bool {
	u, _ := url.Parse(rawURL)

	h := strings.ToLower(strings.TrimSpace(host))
	if u != nil && u.Hostname() != "" {
		h = strings.ToLower(u.Hostname())
	} else if colon := strings.Index(h, ":"); colon >= 0 {
		h = h[:colon]
	}

	path := ""
	if u != nil {
		path = strings.ToLower(u.EscapedPath())
	}

	// QQ 农场登录 Code 只来自这个网关的生产 WebSocket，不能把其他
	// nqf 子域名、其他路径或 query 中碰巧含有 /prod/ws 的请求当成登录入口。
	return h == "gate-obt.nqf.qq.com" && path == "/prod/ws"
}

func IsWxFarmRequest(r *http.Request) bool {
	if r == nil {
		return false
	}
	raw := ""
	if r.URL != nil {
		raw = r.URL.String()
		if q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("platform"))); q == "wx" || q == "wechat" {
			return true
		}
	}
	lower := strings.ToLower(raw)
	return strings.Contains(lower, "platform=wx") || strings.Contains(lower, "platform=wechat")
}

func IsWxFarmURL(rawURL string) bool {
	lower := strings.ToLower(rawURL)
	return strings.Contains(lower, "platform=wx") || strings.Contains(lower, "platform=wechat")
}
