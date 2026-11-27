package game

import (
	"bytes"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"farm-capture/internal/game/pb"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"
)

const (
	msgTypeRequest  = 1
	msgTypeResponse = 2
)

type Config struct {
	WSURL         string
	ClientVersion string
	Platform      string
	OS            string
}

type AccountStatus struct {
	Connected bool   `json:"connected"`
	GID       int64  `json:"gid"`
	Name      string `json:"name"`
	Level     int64  `json:"level"`
	Gold      int64  `json:"gold"`
	Exp       int64  `json:"exp"`
	LastError string `json:"lastError,omitempty"`
}

type Client struct {
	cfg     Config
	code    string
	conn    *websocket.Conn
	seq     atomic.Int64
	server  int64
	pending sync.Map
	status  AccountStatus
	onLog   func(tag, msg string)
	mu      sync.Mutex
}

func NewClient(cfg Config, code, platform string) *Client {
	p := cfg.Platform
	if platform == "wx" {
		p = "wx"
	} else if platform != "" {
		p = platform
	}
	cfg.Platform = p
	return &Client{cfg: cfg, code: code}
}

func (c *Client) SetLogger(fn func(tag, msg string)) { c.onLog = fn }

func (c *Client) log(tag, msg string) {
	log.Printf("[game][%s] %s", tag, msg)
	if c.onLog != nil {
		c.onLog(tag, msg)
	}
}

func (c *Client) Connect() error {
	u, err := url.Parse(c.cfg.WSURL)
	if err != nil {
		return err
	}
	q := u.Query()
	q.Set("platform", c.cfg.Platform)
	q.Set("os", c.cfg.OS)
	q.Set("ver", c.cfg.ClientVersion)
	q.Set("code", c.code)
	q.Set("openID", "")
	u.RawQuery = q.Encode()

	header := http.Header{}
	header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MicroMessenger/7.0.20.1781")
	header.Set("Origin", "https://gate-obt.nqf.qq.com")

	conn, _, err := websocket.DefaultDialer.Dial(u.String(), header)
	if err != nil {
		return err
	}
	c.conn = conn
	go c.readLoop()
	if err := c.login(); err != nil {
		_ = c.Close()
		return err
	}
	c.status.Connected = true
	return nil
}

func (c *Client) Status() AccountStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status
}

func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.status.Connected = false
	if c.conn != nil {
		err := c.conn.Close()
		c.conn = nil
		return err
	}
	return nil
}

func (c *Client) login() error {
	req := &pb.LoginRequest{
		DeviceInfo: &pb.DeviceInfo{
			ClientVersion: c.cfg.ClientVersion,
			SysSoftware:   "Windows 10",
			Network:       "wifi",
			Memory:        16384,
			DeviceId:      "DESKTOP-PC<WPC>",
		},
		SceneId: "1256",
		ReportData: &pb.ReportData{
			MinigameChannel: "other",
			MinigamePlatid:  2,
		},
	}
	body, err := proto.Marshal(req)
	if err != nil {
		return err
	}
	respBody, err := c.request("gamepb.userpb.UserService", "Login", body)
	if err != nil {
		return err
	}
	reply := &pb.LoginReply{}
	if err := proto.Unmarshal(respBody, reply); err != nil {
		return err
	}
	if reply.Basic != nil {
		c.mu.Lock()
		c.status.GID = reply.Basic.Gid
		c.status.Name = reply.Basic.Name
		c.status.Level = reply.Basic.Level
		c.status.Gold = reply.Basic.Gold
		c.status.Exp = reply.Basic.Exp
		c.mu.Unlock()
		c.log("登录", fmt.Sprintf("成功 %s Lv%d", reply.Basic.Name, reply.Basic.Level))
	}
	return nil
}

func (c *Client) request(service, method string, body []byte) ([]byte, error) {
	seq := c.seq.Add(1)
	ch := make(chan respMsg, 1)
	c.pending.Store(seq, ch)
	defer c.pending.Delete(seq)

	if err := c.sendFrame(service, method, msgTypeRequest, seq, body); err != nil {
		return nil, err
	}
	select {
	case r := <-ch:
		if r.err != nil {
			return nil, r.err
		}
		return r.body, nil
	case <-time.After(20 * time.Second):
		return nil, fmt.Errorf("timeout %s.%s", service, method)
	}
}

type respMsg struct {
	body []byte
	err  error
}

func (c *Client) sendFrame(service, method string, msgType int32, clientSeq int64, body []byte) error {
	if c.conn == nil {
		return fmt.Errorf("not connected")
	}
	frame := &pb.Message{
		Meta: &pb.Meta{
			ServiceName: service,
			MethodName:  method,
			MessageType: msgType,
			ClientSeq:   clientSeq,
			ServerSeq:   c.server,
		},
		Body: body,
	}
	data, err := proto.Marshal(frame)
	if err != nil {
		return err
	}
	return c.conn.WriteMessage(websocket.BinaryMessage, data)
}

func (c *Client) readLoop() {
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			c.mu.Lock()
			c.status.Connected = false
			c.status.LastError = err.Error()
			c.mu.Unlock()
			c.log("WS", "断开: "+err.Error())
			return
		}
		c.handleFrame(data)
	}
}

func (c *Client) handleFrame(data []byte) {
	msg := &pb.Message{}
	if err := proto.Unmarshal(data, msg); err != nil {
		return
	}
	if msg.Meta == nil {
		return
	}
	if msg.Meta.ServerSeq > c.server {
		c.server = msg.Meta.ServerSeq
	}
	if msg.Meta.MessageType != msgTypeResponse {
		return
	}
	if msg.Meta.ErrorCode != 0 {
		err := fmt.Errorf("%s.%s code=%d %s", msg.Meta.ServiceName, msg.Meta.MethodName, msg.Meta.ErrorCode, msg.Meta.ErrorMessage)
		if ch, ok := c.pending.Load(msg.Meta.ClientSeq); ok {
			ch.(chan respMsg) <- respMsg{err: err}
		}
		return
	}
	if ch, ok := c.pending.Load(msg.Meta.ClientSeq); ok {
		ch.(chan respMsg) <- respMsg{body: msg.Body}
	}
}

func (c *Client) StealFriend(gid int64) error {
	body := encodeInt64Field1(gid)
	_, err := c.request("gamepb.visitpb.VisitService", "Steal", body)
	return err
}

func encodeInt64Field1(v int64) []byte {
	var buf bytes.Buffer
	buf.WriteByte(0x08)
	buf.Write(encodeVarint(uint64(v)))
	return buf.Bytes()
}

func encodeVarint(v uint64) []byte {
	var out []byte
	for v >= 0x80 {
		out = append(out, byte(v)|0x80)
		v >>= 7
	}
	out = append(out, byte(v))
	return out
}
