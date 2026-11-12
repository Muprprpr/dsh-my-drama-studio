package studio

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

type Request struct {
	SessionID     string          `json:"sessionId"`
	WorkspaceID   string          `json:"workspaceId"`
	WorkspacePath string          `json:"workspacePath"`
	Action        string          `json:"action"`
	Data          json.RawMessage `json:"data"`
}

type requestError struct {
	code int
	text string
}

func (e *requestError) Error() string { return e.text }

func invalid(format string, args ...any) error {
	return &requestError{http.StatusBadRequest, fmt.Sprintf(format, args...)}
}

var notBound = &requestError{http.StatusForbidden, "请先连接当前会话与画布"}

func decode(reader io.Reader, dst any) error {
	d := json.NewDecoder(reader)
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return invalid("请求参数无效：%s", err)
	}
	if d.Decode(new(any)) != io.EOF {
		return invalid("请求只能包含一个 JSON 对象")
	}
	return nil
}

func decodeData(data json.RawMessage, dst any) error {
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		data = json.RawMessage("{}")
	}
	return decode(bytes.NewReader(data), dst)
}

func (s *Service) Handler(token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		var result any
		var err error
		switch {
		case token == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1:
			err = &requestError{http.StatusUnauthorized, "Studio Host 认证失败"}
		case r.Method != http.MethodPost || r.URL.Path != "/":
			err = &requestError{http.StatusNotFound, "未知 Studio 接口"}
		default:
			var request Request
			err = decode(http.MaxBytesReader(w, r.Body, 4<<20), &request)
			if err == nil {
				result, err = s.Execute(r.Context(), request)
			}
		}
		if err != nil {
			code := http.StatusInternalServerError
			var known *requestError
			if errors.As(err, &known) {
				code = known.code
			}
			w.WriteHeader(code)
			result = map[string]string{"error": err.Error()}
		}
		_ = json.NewEncoder(w).Encode(result)
	})
}
