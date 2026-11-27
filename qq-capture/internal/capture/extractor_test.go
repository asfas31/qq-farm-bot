package capture

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestIsFarmGateURL(t *testing.T) {
	tests := []struct {
		name    string
		rawURL  string
		host    string
		matched bool
	}{
		{
			name:    "exact production websocket",
			rawURL:  "https://gate-obt.nqf.qq.com/prod/ws?platform=qq&code=valid",
			matched: true,
		},
		{
			name:    "host header with port",
			rawURL:  "/prod/ws?code=valid",
			host:    "gate-obt.nqf.qq.com:443",
			matched: true,
		},
		{
			name:    "other nqf host",
			rawURL:  "https://other.nqf.qq.com/prod/ws?code=wrong",
			matched: false,
		},
		{
			name:    "other gate path",
			rawURL:  "https://gate-obt.nqf.qq.com/other?code=wrong",
			matched: false,
		},
		{
			name:    "path only appears in query",
			rawURL:  "https://gate-obt.nqf.qq.com/other?next=/prod/ws&code=wrong",
			matched: false,
		},
		{
			name:    "ordinary qq domain",
			rawURL:  "https://qq.com/prod/ws?code=wrong",
			matched: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsFarmGateURL(tt.rawURL, tt.host); got != tt.matched {
				t.Fatalf("IsFarmGateURL(%q, %q) = %v, want %v", tt.rawURL, tt.host, got, tt.matched)
			}
		})
	}
}

func TestQQGateCodeComesOnlyFromExactQueryParameter(t *testing.T) {
	tests := []struct {
		name       string
		url        string
		body       string
		wantCode   string
		wantSource string
		matched    bool
	}{
		{
			name:       "extract exact code query",
			url:        "https://gate-obt.nqf.qq.com/prod/ws?platform=qq&code=valid-code",
			wantCode:   "valid-code",
			wantSource: "gate-query",
			matched:    true,
		},
		{
			name:    "ignore alternate query key",
			url:     "https://gate-obt.nqf.qq.com/prod/ws?js_code=wrong",
			body:    `{"code":"also-wrong"}`,
			matched: true,
		},
		{
			name:    "reject other host query",
			url:     "https://other.nqf.qq.com/prod/ws?code=wrong",
			matched: false,
		},
		{
			name:    "reject ordinary qq query",
			url:     "https://qq.com/login?code=wrong",
			matched: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodGet, tt.url, io.NopCloser(strings.NewReader(tt.body)))
			if err != nil {
				t.Fatal(err)
			}
			result := ExtractFromRequest(req)
			if result.Matched != tt.matched || result.Code != tt.wantCode || result.Source != tt.wantSource {
				t.Fatalf("result = %+v, want matched=%v code=%q source=%q", result, tt.matched, tt.wantCode, tt.wantSource)
			}
		})
	}
}
