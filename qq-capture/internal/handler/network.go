package handler

import (
	"net"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

func (h *Handler) addresses(c *gin.Context) {
	urls := make([]string, 0, len(h.localIPs)+1)
	seen := make(map[string]struct{})

	addURL := func(ip string) {
		ip = strings.TrimSpace(ip)
		if ip == "" {
			return
		}
		url := "http://" + net.JoinHostPort(ip, strconv.Itoa(h.httpPort))
		if _, ok := seen[url]; ok {
			return
		}
		seen[url] = struct{}{}
		urls = append(urls, url)
	}

	for _, ip := range h.localIPs {
		addURL(ip)
	}
	addURL(h.publicHost)

	c.JSON(200, gin.H{
		"ok":          true,
		"port":        h.httpPort,
		"publicHost":  h.publicHost,
		"ips":         h.localIPs,
		"urls":        urls,
		"hotspotHint": "若路由器 WiFi 无法互访，请开启电脑移动热点，手机连热点后访问 http://192.168.137.1:" + strconv.Itoa(h.httpPort),
	})
}

func DetectLocalIPs() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}

	type ipEntry struct {
		ip       string
		priority int
	}

	entries := make([]ipEntry, 0)
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() {
				continue
			}
			ip = ip.To4()
			if ip == nil {
				continue
			}
			s := ip.String()
			if strings.HasPrefix(s, "169.254.") {
				continue
			}
			entries = append(entries, ipEntry{
				ip:       s,
				priority: ipPriority(s),
			})
		}
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].priority == entries[j].priority {
			return entries[i].ip < entries[j].ip
		}
		return entries[i].priority < entries[j].priority
	})

	seen := make(map[string]struct{})
	ips := make([]string, 0, len(entries))
	for _, entry := range entries {
		if _, ok := seen[entry.ip]; ok {
			continue
		}
		seen[entry.ip] = struct{}{}
		ips = append(ips, entry.ip)
	}
	return ips
}

func PickPublicHost(cfgHost string, ips []string) string {
	if strings.TrimSpace(cfgHost) != "" {
		return strings.TrimSpace(cfgHost)
	}
	if len(ips) == 0 {
		return "127.0.0.1"
	}
	return ips[0]
}

func ipPriority(ip string) int {
	switch {
	case strings.HasPrefix(ip, "192.168.137."):
		return 0
	case strings.HasPrefix(ip, "192.168."):
		return 1
	case strings.HasPrefix(ip, "10."):
		return 2
	case strings.HasPrefix(ip, "172."):
		return 3
	default:
		return 9
	}
}
