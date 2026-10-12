package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

func main() {
	if os.Getenv("LAKE_SSH_ASKPASS") == "1" {
		code := 1
		func() {
			defer func() { recover() }()
			if len(os.Args) == 2 && ai.SSHAskpass(os.Args[1], os.Stdout) == nil {
				code = 0
			}
		}()
		os.Exit(code)
	}
	home, _ := os.UserHomeDir()
	dir := flag.String("data", filepath.Join(home, ".lake", "web-agent", "ai"), "private AI state directory")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := ai.Serve(ctx, *dir, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "Lake AI worker stopped")
		os.Exit(1)
	}
}
