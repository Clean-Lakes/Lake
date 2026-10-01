package main

import (
	"context"
	"errors"
	"io"
	"os"

	"github.com/cloudwego/eino/client/tui"
	"github.com/cloudwego/eino/lake/server"
	"github.com/cloudwego/eino/lake/store"
	"golang.org/x/term"
)

func tuiCommand(ctx context.Context, data *store.Store, args []string, out io.Writer) error {
	if len(args) != 0 {
		return errors.New("用法：lake tui")
	}
	web, err := server.New(server.Config{Store: data, ListenAddress: "127.0.0.1:0"})
	if err != nil {
		return err
	}
	if term.IsTerminal(int(os.Stdin.Fd())) {
		original, err := term.MakeRaw(int(os.Stdin.Fd()))
		if err != nil {
			return err
		}
		defer term.Restore(int(os.Stdin.Fd()), original)
	}
	return tui.Run(ctx, tui.API{Handler: web.Handler()}, os.Stdin, out)
}
