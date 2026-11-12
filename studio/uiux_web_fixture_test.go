package studio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	video := os.Getenv("DRAMA_UIUX_PROVIDER_FIXTURE")
	if video == "" {
		os.Exit(m.Run())
	}
	if err := runUIUXWebFixture(video); err != nil {
		fmt.Fprintln(os.Stderr, "UIUX provider fixture:", err)
		os.Exit(1)
	}
	os.Exit(0)
}

// Runs only from the isolated Web test's copied plugin directory. The service,
// adapter, task worker, transactions, and HTTP handler are the production code.
func runUIUXWebFixture(video string) error {
	home, token := os.Getenv("DSH_HOME"), os.Getenv("DRAMA_STUDIO_TOKEN")
	if home == "" || token == "" || !filepath.IsAbs(video) {
		return errors.New("isolated DSH home, token and existing absolute video path required")
	}
	settings, err := OpenProfileSettings("")
	if err != nil {
		return err
	}
	settings.client.Transport = testTransport(func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("Authorization") != "Bearer uiux-local-fixture-token" {
			return nil, errors.New("unexpected fixture credential")
		}
		code := http.StatusOK
		headers := make(http.Header)
		headers.Set("Content-Type", "application/json")
		var body string
		switch req.Method + " " + req.URL.Host + req.URL.Path {
		case "POST video.example.com/v1/videos":
			var input map[string]any
			if json.NewDecoder(req.Body).Decode(&input) != nil || input["model"] != "fixture-video" ||
				input["seconds"] != "8" || input["prompt"] != "固定中景。人物推开餐厅门，在门口停顿。" {
				return nil, errors.New("unexpected fixture generation parameters")
			}
			code = http.StatusCreated
			body = `{"id":"uiux-fixture-task","status":"queued"}`
		case "GET video.example.com/v1/videos/uiux-fixture-task":
			body = `{"id":"uiux-fixture-task","status":"in_progress"}`
			if _, err := os.Stat(filepath.Join(home, "allow-fixture-result")); err == nil {
				body = `{"id":"uiux-fixture-task","status":"completed"}`
			}
		case "GET video.example.com/v1/videos/uiux-fixture-task/content":
			file, err := os.Open(video)
			if err != nil {
				return nil, err
			}
			headers.Set("Content-Type", "video/mp4")
			return &http.Response{StatusCode: code, Header: headers, Body: file}, nil
		default:
			return nil, errors.New("unexpected UIUX fixture request")
		}
		return &http.Response{StatusCode: code, Header: headers, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	service := New(settings)
	defer service.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		service.Run(ctx)
	}()
	server := &http.Server{Handler: service.Handler(token), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		cancel()
		_ = server.Close()
	}()
	fmt.Printf("http://%s\n", listener.Addr())
	err = server.Serve(listener)
	cancel()
	<-done
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
