package studio

import (
	"context"
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

	"github.com/google/uuid"
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
	settings, err := OpenProviderSettings(filepath.Join(home, "my-drama-studio", "providers.dpapi"))
	if err != nil {
		return err
	}
	preset := ProviderProfile{ID: uuid.NewString(), Provider: "replicate", Name: "本地验收夹具", Model: "wan-video/wan-2.7-t2v", Mode: "t2v"}
	settings.data.Profiles = []ProviderProfile{preset}
	settings.data.Defaults["t2v"] = preset.ID
	settings.data.Keys["replicate"] = "uiux-local-fixture-token"
	settings.client.Transport = testTransport(func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("Authorization") != "Bearer uiux-local-fixture-token" {
			return nil, errors.New("unexpected fixture credential")
		}
		code := http.StatusOK
		headers := make(http.Header)
		headers.Set("Content-Type", "application/json")
		var body string
		switch req.Method + " " + req.URL.Host + req.URL.Path {
		case "POST api.replicate.com/v1/models/wan-video/wan-2.7-t2v/predictions":
			code = http.StatusCreated
			body = `{"id":"uiux-fixture-task","status":"starting"}`
		case "GET api.replicate.com/v1/predictions/uiux-fixture-task":
			body = `{"id":"uiux-fixture-task","status":"processing"}`
			if _, err := os.Stat(filepath.Join(home, "allow-fixture-result")); err == nil {
				body = `{"id":"uiux-fixture-task","status":"succeeded","output":"https://replicate.delivery/uiux/existing-asset.mp4"}`
			}
		case "GET replicate.delivery/uiux/existing-asset.mp4":
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
