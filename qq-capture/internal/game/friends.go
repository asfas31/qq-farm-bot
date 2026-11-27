package game

import (
	"farm-capture/internal/capture"
	"fmt"
)

func (c *Client) FetchFriends() ([]capture.FriendRecord, error) {
	attempts := []struct {
		service string
		method  string
	}{
		{"gamepb.friendpb.FriendService", "SyncAll"},
		{"gamepb.friendpb.FriendService", "GetAll"},
		{"gamepb.friendpb.FriendService", "GetGameFriends"},
	}

	var lastErr error
	for _, attempt := range attempts {
		resp, err := c.request(attempt.service, attempt.method, []byte{})
		if err != nil {
			lastErr = err
			continue
		}
		records := capture.ParseFriendReplyBody(resp)
		if len(records) > 0 {
			c.log("好友", fmt.Sprintf("主动拉取 %d 人 via %s", len(records), attempt.method))
			return records, nil
		}
	}

	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("friend list empty")
}
