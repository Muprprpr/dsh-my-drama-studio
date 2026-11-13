package studio

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// ConfigureHostActivity connects transaction admission to the parent Host's live Agent registry.
func (s *Service) ConfigureHostActivity(address, token string) error {
	if address == "" {
		return nil
	}
	parsed, err := url.Parse(address)
	if err != nil {
		return err
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" ||
		parsed.Path != "/human-write" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || token == "" {
		return fmt.Errorf("invalid Studio Host activity endpoint")
	}
	client := &http.Client{
		Timeout: 2 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	s.SetHumanWriteCheck(func(ctx context.Context, workspaceID, sessionID string, connected, nodeIDs []string) (bool, error) {
		body, err := json.Marshal(struct {
			WorkspaceID string   `json:"workspaceId"`
			SessionID   string   `json:"sessionId"`
			SessionIDs  []string `json:"sessionIds"`
			NodeIDs     []string `json:"nodeIds"`
		}{workspaceID, sessionID, connected, nodeIDs})
		if err != nil {
			return false, err
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, address, bytes.NewReader(body))
		if err != nil {
			return false, err
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		response, err := client.Do(request)
		if err != nil {
			return false, err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return false, fmt.Errorf("Studio Host activity check returned HTTP %d", response.StatusCode)
		}
		var result struct {
			Allowed *bool `json:"allowed"`
		}
		if err := decode(io.LimitReader(response.Body, 4096), &result); err != nil {
			return false, err
		}
		if result.Allowed == nil {
			return false, fmt.Errorf("Studio Host activity check returned no decision")
		}
		return *result.Allowed, nil
	})
	return nil
}
