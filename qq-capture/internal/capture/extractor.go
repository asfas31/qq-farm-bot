package capture

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

var codeKeys = []string{"code", "js_code", "auth_code", "login_code", "authorization_code"}

// Match domains commonly used by QQ / WeChat mini programs.
// Adjust after first capture run if your farm uses different hosts.
var farmHostPatterns = []string{
	"gate-obt.nqf.qq.com",
	"servicewechat.com",
	"myapp.com",
	"yingyongbao.com",
}

type Result struct {
	Code    string
	Source  string
	URL     string
	Method  string
	Matched bool
}

func ExtractFromRequest(r *http.Request) Result {
	res := Result{
		URL:    r.URL.String(),
		Method: r.Method,
	}

	if !looksLikeFarmRequest(r) {
		return res
	}

	if IsFarmGateRequest(r) {
		res.Matched = true
		if code := strings.TrimSpace(r.URL.Query().Get("code")); code != "" {
			res.Code = code
			res.Source = "gate-query"
		}
		return res
	}

	if r.Body == nil {
		return res
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		return res
	}
	r.Body = io.NopCloser(bytes.NewReader(body))

	if len(body) == 0 {
		return res
	}

	if code := extractFromJSON(body); code != "" {
		res.Code = code
		res.Source = "json"
		res.Matched = true
		return res
	}

	if code := extractFromForm(body, r.Header.Get("Content-Type")); code != "" {
		res.Code = code
		res.Source = "form"
		res.Matched = true
		return res
	}

	if code := extractFromRaw(string(body)); code != "" {
		res.Code = code
		res.Source = "body"
		res.Matched = true
	}

	return res
}

func looksLikeFarmRequest(r *http.Request) bool {
	if IsFarmGateRequest(r) {
		return true
	}

	host := strings.ToLower(r.Host)
	if host == "" && r.URL != nil {
		host = strings.ToLower(r.URL.Host)
	}

	for _, p := range farmHostPatterns {
		if strings.Contains(host, p) {
			return true
		}
	}

	full := strings.ToLower(r.URL.String())
	for _, p := range farmHostPatterns {
		if strings.Contains(full, p) {
			return true
		}
	}

	// 非 QQ 平台的兼容抓取仅在已知微信/应用宝域名上检查 body。
	// 不能因为任意 URL 带有 code 参数就把它视作农场请求。
	return false
}

func extractFromURL(u *url.URL) string {
	if u == nil {
		return ""
	}
	q := u.Query()
	for _, key := range codeKeys {
		if v := strings.TrimSpace(q.Get(key)); v != "" {
			return v
		}
	}
	return ""
}

func extractFromJSON(body []byte) string {
	var data map[string]any
	if err := json.Unmarshal(body, &data); err != nil {
		return ""
	}
	return findCodeInMap(data)
}

func findCodeInMap(m map[string]any) string {
	for _, key := range codeKeys {
		if v, ok := m[key]; ok {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				return strings.TrimSpace(s)
			}
		}
	}
	for _, v := range m {
		switch nested := v.(type) {
		case map[string]any:
			if code := findCodeInMap(nested); code != "" {
				return code
			}
		}
	}
	return ""
}

func extractFromForm(body []byte, contentType string) string {
	if !strings.Contains(contentType, "application/x-www-form-urlencoded") {
		return ""
	}
	vals, err := url.ParseQuery(string(body))
	if err != nil {
		return ""
	}
	for _, key := range codeKeys {
		if v := strings.TrimSpace(vals.Get(key)); v != "" {
			return v
		}
	}
	return ""
}

var rawCodePattern = regexp.MustCompile(`(?i)(?:code|js_code|auth_code)["\s:=]+["']?([A-Za-z0-9_\-]{8,})`)

func extractFromRaw(s string) string {
	m := rawCodePattern.FindStringSubmatch(s)
	if len(m) >= 2 {
		return m[1]
	}
	return ""
}
