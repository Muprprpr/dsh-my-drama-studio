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
	if err := service.ConfigureHostActivity(os.Getenv("DRAMA_STUDIO_ACTIVITY_URL"), token); err != nil {
		_ = service.Close()
		return err
	}
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		service.Run(ctx)
	}()
	server := &http.Server{
		Handler: service.Handler(token), ReadHeaderTimeout: 5 * time.Second,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- server.Serve(listener)
	}()

	fmt.Printf("http://%s\n", listener.Addr())
	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-serveDone:
		stop()
	}
	if errors.Is(serveErr, http.ErrServerClosed) {
		serveErr = nil
	}

	// HTTP and Worker drain concurrently within the kernel's total budget.
	drain, cancelDrain := context.WithTimeout(context.Background(), studio.GenerationShutdownTimeout)
	defer cancelDrain()
	httpDrain, cancelHTTPDrain := context.WithTimeout(drain, 5*time.Second)
	shutdownErr := server.Shutdown(httpDrain)
	cancelHTTPDrain()
	if shutdownErr != nil {
		_ = server.Close()
	}
	cleanup := make(chan error, 1)
	go func() {
		<-workerDone
		cleanup <- service.Close()
	}()
	select {
	case closeErr := <-cleanup:
		return errors.Join(serveErr, shutdownErr, closeErr)
	case <-drain.Done():
		return errors.Join(serveErr, shutdownErr, errors.New("Studio Go shutdown budget exhausted"))
	}
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
