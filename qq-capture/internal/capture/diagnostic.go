package capture

import (
	"net/url"
	"strings"
)

func IsWechatFarmUIHost(host string) bool {
	h := strings.ToLower(host)
	if idx := strings.Index(h, ":"); idx >= 0 {
		h = h[:idx]
	}
	return strings.Contains(h, "galileotelemetry.tencent.com") ||
		strings.Contains(h, "data.ab.qq.com") ||
		strings.Contains(h, "thirdwx.qlogo.cn")
}

func ExtractCodeFromBytes(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	if code := extractFromJSON(body); code != "" {
		return code
	}
	text := string(body)
	if code := extractFromRaw(text); code != "" {
		return code
	}
	if idx := strings.Index(text, "gate-obt.nqf.qq.com"); idx >= 0 {
		fragment := text[idx:]
		if end := strings.IndexAny(fragment, "\"' \n\r\t"); end > 0 {
			fragment = fragment[:end]
		}
		if u, err := parseURLish(fragment); err == nil {
			if code := extractFromURL(u); code != "" {
				return code
			}
		}
	}
	return ""
}

func parseURLish(raw string) (*url.URL, error) {
	if strings.HasPrefix(raw, "http") {
		return url.Parse(raw)
	}
	return url.Parse("https://" + raw)
}
