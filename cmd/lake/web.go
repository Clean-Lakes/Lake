package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cloudwego/eino/lake/server"
	"github.com/cloudwego/eino/lake/store"
)

type originFlags []string

func (o *originFlags) String() string { return strings.Join(*o, ",") }
func (o *originFlags) Set(value string) error {
	if value == "" {
		return errors.New("Origin 不能为空")
	}
	*o = append(*o, value)
	return nil
}

func webCommand(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("lake web 需要 serve 或 token-create")
	}
	switch args[0] {
	case "token-create":
		f := flags("lake web token-create", errOut)
		path := f.String("file", filepath.Join(s.Root(), "web.token"), "私有令牌文件")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 {
			return errors.New("参数过多")
		}
		if err := os.MkdirAll(filepath.Dir(*path), 0700); err != nil {
			return err
		}
		bytes := make([]byte, 32)
		if _, err := rand.Read(bytes); err != nil {
			return err
		}
		file, err := os.OpenFile(*path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		defer file.Close()
		if _, err := file.WriteString(base64.RawURLEncoding.EncodeToString(bytes)); err != nil {
			return err
		}
		_, err = fmt.Fprintf(out, "已创建私有 Web 令牌文件：%s\n", *path)
		return err
	case "serve":
		f := flags("lake web serve", errOut)
		listen := f.String("listen", "127.0.0.1:8765", "监听地址")
		tokenFile := f.String("token-file", "", "Bearer 令牌文件")
		cert := f.String("tls-cert", "", "TLS 证书")
		key := f.String("tls-key", "", "TLS 私钥")
		var origins originFlags
		f.Var(&origins, "origin", "允许的 Origin，可重复")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 || (*cert == "") != (*key == "") {
			return errors.New("Web 参数无效；TLS 证书和私钥须同时指定")
		}
		token := ""
		if *tokenFile != "" {
			loaded, err := readWebToken(*tokenFile)
			if err != nil {
				return err
			}
			token = loaded
		}
		web, err := server.New(server.Config{Store: s, ListenAddress: *listen, Token: token, AllowedOrigins: origins, TLS: *cert != ""})
		if err != nil {
			return err
		}
		listener, err := net.Listen("tcp", *listen)
		if err != nil {
			return err
		}
		defer listener.Close()
		httpServer := &http.Server{Handler: webPageHandler(web.Handler()), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
		go func() {
			<-ctx.Done()
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = httpServer.Shutdown(shutdownCtx)
		}()
		fmt.Fprintf(out, "Lake Web 事件服务监听 %s\n", listener.Addr())
		if *cert != "" {
			err = httpServer.ServeTLS(listener, *cert, *key)
		} else {
			err = httpServer.Serve(listener)
		}
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	default:
		return fmt.Errorf("未知 Web 命令 %q", args[0])
	}
}

func readWebToken(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 256 {
		return "", errors.New("Web 令牌文件须为私有普通文件且不超过 256 字节")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	defer clearBytes(content)
	token := strings.TrimSpace(string(content))
	if len(token) < 32 {
		return "", errors.New("Web 令牌至少需要 32 字符")
	}
	return token, nil
}
