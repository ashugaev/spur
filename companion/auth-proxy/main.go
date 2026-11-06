package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	sdkapi "github.com/router-for-me/CLIProxyAPI/v8/sdk/api"
	sdkauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	_ "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator/builtin"
	log "github.com/sirupsen/logrus"
	"gopkg.in/yaml.v3"
)

func main() {
	dataDir := flag.String("data-dir", "", "Spur data directory")
	workerID := flag.String("login-worker", "", "private account sign-in worker")
	workerProvider := flag.String("provider", "", "sign-in provider")
	flag.Parse()
	log.SetOutput(io.Discard)
	gin.SetMode(gin.ReleaseMode)
	gin.DefaultWriter, gin.DefaultErrorWriter = io.Discard, io.Discard
	if *dataDir == "" {
		fmt.Fprintln(os.Stderr, "auth proxy requires --data-dir")
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	if *workerID != "" {
		if err := loginWorker(ctx, *dataDir, *workerID, provider(*workerProvider)); err != nil {
			var identityErr *identityError
			if errors.As(err, &identityErr) {
				fmt.Fprintln(os.Stdout, identityErr.marker)
			}
			os.Exit(1)
		}
		return
	}
	output := os.Stdout
	// SDK startup and authenticators use fmt.Printf. Control owns original stdout.
	discard, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		os.Exit(1)
	}
	os.Stdout = discard
	if err = run(ctx, cancel, *dataDir, os.Stdin, output); err != nil {
		fmt.Fprintln(os.Stderr, "Spur auth proxy stopped:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, cancel context.CancelFunc, dir string, input io.Reader, output io.Writer) error {
	r, err := openRouter(dir)
	if err != nil {
		return err
	}
	defer r.close()
	store := tokenStore(r.dir)
	manager := coreauth.NewManager(store, r, r)
	logins := &loginManager{dir: r.dir, manager: manager, store: store, attempts: map[string]*loginAttempt{}}
	r.readyAccount = logins.ready
	port, err := endpointPort(r.state.Endpoint)
	if err != nil {
		return err
	}
	cfg, err := config.ParseConfigBytes([]byte("host: 127.0.0.1\nport: 1\nrequest-retry: 0\nmax-retry-credentials: 0\nmax-retry-interval: 0\ndisable-claude-cloak-mode: true\ncommercial-mode: true\nplugins:\n  enabled: false\nremote-management:\n  disable-control-panel: true\n"))
	if err != nil {
		return errors.New("could not configure auth transport")
	}
	cfg.Port, cfg.AuthDir = port, filepath.Join(r.dir, "auth-proxy-credentials")
	cfgPath := filepath.Join(r.dir, "auth-proxy-sdk.yaml")
	cfgBytes, err := yaml.Marshal(cfg)
	if err != nil {
		return errors.New("could not encode auth transport configuration")
	}
	if err = atomicPrivateWrite(cfgPath, cfgBytes); err != nil {
		return errors.New("could not persist auth transport configuration")
	}
	probeKey, err := randomKey()
	if err != nil {
		return err
	}
	started := make(chan struct{}, 1)
	service, err := cliproxy.NewBuilder().WithConfig(cfg).WithConfigPath(cfgPath).WithCoreAuthManager(manager).
		WithAuthManager(sdkauth.NewManager(store, sdkauth.NewClaudeAuthenticator(), sdkauth.NewCodexAuthenticator())).
		WithServerOptions(sdkapi.WithMiddleware(r.middleware(probeKey))).
		WithHooks(cliproxy.Hooks{OnAfterStart: func(*cliproxy.Service) { started <- struct{}{} }}).Build()
	if err != nil {
		return errors.New("could not initialize auth transport")
	}
	serverDone := make(chan error, 1)
	go func() { serverDone <- service.Run(ctx) }()
	defer func() {
		cancel()
		shutdownCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = service.Shutdown(shutdownCtx)
	}()
	select {
	case <-started:
	case <-ctx.Done():
		return nil
	case <-time.After(10 * time.Second):
		return errors.New("auth transport readiness timed out")
	case <-serverDone:
		return errors.New("auth transport could not bind its saved endpoint")
	}
	client := &http.Client{Timeout: 2 * time.Second}
	probe, err := http.NewRequestWithContext(ctx, http.MethodGet, r.state.Endpoint+"/_spur/readiness", nil)
	if err != nil {
		return err
	}
	probe.Header.Set("X-Spur-Readiness", probeKey)
	resp, err := client.Do(probe)
	if err != nil {
		return errors.New("auth transport could not bind its saved endpoint")
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return errors.New("auth transport endpoint ownership check failed")
	}
	if err = json.NewEncoder(output).Encode(struct {
		Event    string `json:"event"`
		Endpoint string `json:"endpoint"`
	}{"ready", r.state.Endpoint}); err != nil {
		return err
	}
	c := &control{out: output, router: r, logins: logins}
	controlDone := make(chan error, 1)
	go func() { controlDone <- c.serve(ctx, input) }()
	select {
	case <-ctx.Done():
		return nil
	case err := <-controlDone:
		return err
	case <-serverDone:
		return errors.New("auth transport stopped")
	}
}
