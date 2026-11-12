package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"dsh-my-drama-studio/studio"
)

func run() error {
	token := os.Getenv("DRAMA_STUDIO_TOKEN")
	if token == "" {
		return errors.New("DRAMA_STUDIO_TOKEN is required")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		stop()
	}()
	home := os.Getenv("DSH_HOME")
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		home = filepath.Join(userHome, ".dsh")
	}
	providers, err := studio.OpenProfileSettings(filepath.Join(home, "my-drama-studio", "providers.dpapi"))
	if err != nil {
		return err
	}
	service := studio.New(providers)
	defer service.Close()
	if err := service.ConfigureHostActivity(os.Getenv("DRAMA_STUDIO_ACTIVITY_URL"), token); err != nil {
		return err
	}
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		service.Run(ctx)
	}()
	defer func() {
		stop()
		<-workerDone
	}()
	server := &http.Server{
		Handler: service.Handler(token), ReadHeaderTimeout: 5 * time.Second,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	shutdown := make(chan error, 1)
	go func() {
		<-ctx.Done()
		deadline, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		err := server.Shutdown(deadline)
		if err != nil {
			_ = server.Close()
		}
		shutdown <- err
	}()

	fmt.Printf("http://%s\n", listener.Addr())
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return <-shutdown
	}
	return err
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
