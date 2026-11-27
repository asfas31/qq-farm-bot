package capture

import (
	"bytes"
	"log"
	"strings"

	gamepb "farm-capture/internal/game/pb"

	"google.golang.org/protobuf/proto"
)

var friendServiceMarkers = [][]byte{
	[]byte("FriendService"),
	[]byte("friendpb"),
	[]byte("gamepb.friendpb"),
}

var friendReplyMethods = map[string]bool{
	"GetAll":         true,
	"SyncAll":        true,
	"GetGameFriends": true,
}

// PlantInfo 好友农场摘要
type PlantInfo struct {
	StealPlantNum uint32 `json:"steal_plant_num,omitempty"`
	DryNum        uint32 `json:"dry_num,omitempty"`
	WeedNum       uint32 `json:"weed_num,omitempty"`
	InsectNum     uint32 `json:"insect_num,omitempty"`
}

// FriendRecord 好友信息
type FriendRecord struct {
	GID       uint64     `json:"gid"`
	OpenID    string     `json:"open_id,omitempty"`
	Name      string     `json:"name,omitempty"`
	AvatarURL string     `json:"avatar_url,omitempty"`
	Level     uint32     `json:"level,omitempty"`
	Gold      uint64     `json:"gold,omitempty"`
	Plant     *PlantInfo `json:"plant,omitempty"`
}

// ExtractFriendsFromPayload 从 HTTP 响应或 WebSocket 二进制帧中提取好友列表
func ExtractFriendsFromPayload(body []byte) ([]FriendRecord, bool) {
	if len(body) == 0 {
		return nil, false
	}

	if friends, ok := extractFriendsFromGateMessage(body); ok {
		return friends, true
	}

	if friends, ok := scanFriendMessages(body); ok {
		return friends, true
	}

	if !containsFriendMarker(body) {
		return nil, false
	}

	friends := extractFriendsFromRawProtobuf(body)
	if len(friends) > 0 {
		return friends, true
	}
	return nil, true
}

// ExtractFriendGIDs 兼容旧接口
func ExtractFriendGIDs(body []byte) ([]uint64, bool) {
	friends, ok := ExtractFriendsFromPayload(body)
	if !ok {
		return nil, false
	}
	if len(friends) == 0 {
		return nil, containsFriendMarker(body)
	}
	gids := make([]uint64, 0, len(friends))
	for _, f := range friends {
		if f.GID > 0 {
			gids = append(gids, f.GID)
		}
	}
	return gids, true
}

func containsFriendMarker(body []byte) bool {
	for _, marker := range friendServiceMarkers {
		if bytes.Contains(body, marker) {
			return true
		}
	}
	return false
}

func scanFriendMessages(body []byte) ([]FriendRecord, bool) {
	var best []FriendRecord
	for i := 0; i < len(body); i++ {
		if i > 0 && body[i] != 0x0a && body[i] != 0x12 {
			continue
		}
		msg := &gamepb.Message{}
		if err := proto.Unmarshal(body[i:], msg); err != nil || msg.Meta == nil {
			continue
		}
		friends, ok := friendsFromMessage(msg)
		if ok && len(friends) > len(best) {
			best = friends
		}
	}
	if len(best) == 0 {
		return nil, false
	}
	return best, true
}

func extractFriendsFromGateMessage(body []byte) ([]FriendRecord, bool) {
	msg := &gamepb.Message{}
	if err := proto.Unmarshal(body, msg); err != nil {
		return nil, false
	}
	return friendsFromMessage(msg)
}

func friendsFromMessage(msg *gamepb.Message) ([]FriendRecord, bool) {
	if msg == nil || msg.Meta == nil {
		return nil, false
	}

	service := msg.Meta.GetServiceName()
	method := msg.Meta.GetMethodName()
	msgType := msg.Meta.GetMessageType()

	if !strings.Contains(service, "friendpb") && !strings.Contains(service, "FriendService") {
		return nil, false
	}
	if msgType != 2 && msgType != 3 {
		return nil, false
	}
	if msgType == 2 && !friendReplyMethods[method] && method != "" {
		return nil, false
	}

	friends := parseFriendReply(msg.Body)
	if len(friends) == 0 {
		return nil, false
	}
	log.Printf("[friend] parsed %d friends from %s.%s type=%d", len(friends), service, method, msgType)
	return friends, true
}

func extractFriendsFromRawProtobuf(body []byte) []FriendRecord {
	decoded, err := NewProtobufDecoder(body).Decode()
	if err != nil {
		return nil
	}
	return parseFriendReplyMap(decoded)
}

// ParseFriendReplyBody 解析好友列表回复体
func ParseFriendReplyBody(body []byte) []FriendRecord {
	return parseFriendReply(body)
}

func parseFriendReply(body []byte) []FriendRecord {
	if len(body) == 0 {
		return nil
	}

	decoded, err := NewProtobufDecoder(body).Decode()
	if err == nil {
		if friends := parseFriendReplyMap(decoded); len(friends) > 0 {
			return friends
		}
	}

	// 兼容 GetAllReply / SyncAllReply / FriendAddedNotify 等结构
	if friends := parseFriendReplyMap(map[int]interface{}{1: decodeRepeatedMessages(body, 1)}); len(friends) > 0 {
		return friends
	}

	return nil
}

func decodeRepeatedMessages(body []byte, fieldNum int) []interface{} {
	decoded, err := NewProtobufDecoder(body).Decode()
	if err != nil {
		return nil
	}
	return GetArray(decoded, fieldNum)
}

func parseFriendReplyMap(decoded map[int]interface{}) []FriendRecord {
	items := GetArray(decoded, 1)
	if len(items) == 0 {
		return nil
	}

	records := make([]FriendRecord, 0, len(items))
	seen := make(map[uint64]bool)
	for _, item := range items {
		m, ok := item.(map[int]interface{})
		if !ok {
			continue
		}
		record := parseGameFriend(m)
		if record.GID == 0 || seen[record.GID] {
			continue
		}
		seen[record.GID] = true
		records = append(records, record)
	}
	return records
}

func parseGameFriend(data map[int]interface{}) FriendRecord {
	record := FriendRecord{
		GID:       GetUint64(data, 1),
		OpenID:    fieldString(data, 2),
		Name:      fieldString(data, 3),
		AvatarURL: fieldString(data, 4),
		Level:     uint32(GetUint64(data, 6)),
		Gold:      GetUint64(data, 7),
	}
	if plantMap := GetMap(data, 9); plantMap != nil {
		plant := &PlantInfo{
			StealPlantNum: uint32(GetUint64(plantMap, 6)),
			DryNum:        uint32(GetUint64(plantMap, 7)),
			WeedNum:       uint32(GetUint64(plantMap, 8)),
			InsectNum:     uint32(GetUint64(plantMap, 9)),
		}
		if plant.StealPlantNum > 0 || plant.DryNum > 0 || plant.WeedNum > 0 || plant.InsectNum > 0 {
			record.Plant = plant
		}
	}
	return record
}

func fieldString(data map[int]interface{}, fieldNum int) string {
	val, ok := data[fieldNum]
	if !ok {
		return ""
	}
	switch v := val.(type) {
	case []byte:
		return string(v)
	case string:
		return v
	default:
		return ""
	}
}

func fieldBytes(data map[int]interface{}, fieldNum int) []byte {
	val, ok := data[fieldNum]
	if !ok {
		return nil
	}
	if b, ok := val.([]byte); ok {
		return b
	}
	return nil
}
