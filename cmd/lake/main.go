package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	webassets "github.com/Clean-Lakes/Lake/assets/web"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/web"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var version = "0.3.7" // Release builds inject the repository VERSION through -ldflags.

func main() {
	if os.Getenv("LAKE_SSH_ASKPASS") == "1" {
		// stdout belongs to OpenSSH's helper pipe. Never emit credentials as errors.
		code := 1
		func() {
			defer func() { recover() }()
			if len(os.Args) == 2 && web.SSHAskpass(os.Args[1], os.Stdout) == nil {
				code = 0
			}
		}()
		if code != 0 {
			fmt.Fprintln(os.Stderr, web.SSHAskpassFailureMessage)
		}
		os.Exit(code)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if e := run(ctx, os.Args[1:]); e != nil {
		fmt.Fprintln(os.Stderr, "lake:", e)
		os.Exit(1)
	}
}
func run(ctx context.Context, args []string) (err error) {
	defer func() {
		if p := recover(); p != nil {
			if f, ok := p.(*web.Failure); ok {
				err = f
			} else {
				err = errors.New("operation failed")
			}
		}
	}()
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Println(help)
		return nil
	}
	if args[0] == "--version" || args[0] == "version" {
		fmt.Println("Lake " + version + " · Go backend · React frontend")
		return nil
	}
	if args[0] == "secrets" {
		return migrate(args[1:])
	}
	if args[0] == "web" || args[0] == "serve" {
		flags := flag.NewFlagSet("lake web", flag.ContinueOnError)
		flags.SetOutput(os.Stderr)
		port := flags.Int("port", envPort(), "localhost port (0 selects a free port)")
		home := flags.String("home", lakeHome(), "private Lake data directory")
		open := flags.Bool("open", false, "open authenticated browser")
		if e := flags.Parse(args[1:]); e != nil {
			if errors.Is(e, flag.ErrHelp) {
				return nil
			}
			return e
		}
		if flags.NArg() != 0 {
			return errors.New("unknown web argument")
		}
		if *port < 0 || *port > 65535 {
			return errors.New("invalid web port")
		}
		os.Setenv("LAKE_HOME", *home)
		dataDir := ""
		flags.Visit(func(f *flag.Flag) {
			if f.Name == "home" {
				dataDir = filepath.Join(*home, "web-agent")
			}
		})
		b, e := web.New(ctx, web.Options{Home: *home, DataDir: dataDir, Port: *port, DynamicPort: *port == 0, Open: *open || os.Getenv("LAKE_WEB_START_OPEN") == "1", Static: webassets.Files(), DevOrigin: os.Getenv("LAKE_WEB_DEV_ORIGIN")})
		if e != nil {
			return e
		}
		defer b.Close()
		return b.Start()
	}
	if args[0] == "ai" {
		flags := flag.NewFlagSet("lake ai", flag.ContinueOnError)
		dir := flags.String("data", filepath.Join(lakeHome(), "web-agent", "ai"), "AI state directory")
		if e := flags.Parse(args[1:]); e != nil {
			return e
		}
		return ai.Serve(ctx, *dir, os.Stdin, os.Stdout)
	}
	if args[0] == "status" {
		cmd := exec.CommandContext(ctx, platform.Executable("/usr/bin/uname"), "-a")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}
	flags := flag.NewFlagSet("lake "+args[0], flag.ContinueOnError)
	home := flags.String("home", lakeHome(), "Lake home")
	session := flags.String("session", "", "session ID")
	message := flags.String("message", "", "user message")
	if e := flags.Parse(args[1:]); e != nil {
		return e
	}
	client, e := connect(*home)
	if e != nil {
		return e
	}
	switch args[0] {
	case "open":
		return openURL(client.origin + "/#token=" + url.QueryEscape(client.token))
	case "doctor":
		v, e := client.request(ctx, "GET", "/api/bootstrap", nil)
		if e != nil {
			return e
		}
		return printJSON(v)
	case "models":
		v, e := client.request(ctx, "GET", "/api/settings/model", nil)
		if e != nil {
			return e
		}
		return printJSON(v)
	case "resources", "projects", "sessions":
		rest := flags.Args()
		sub := "list"
		if len(rest) > 0 {
			sub = rest[0]
		}
		if args[0] == "sessions" && len(rest) > 1 && (sub == "show" || sub == "delete") {
			path := "/api/sessions/" + url.PathEscape(rest[1])
			method := "DELETE"
			if sub == "show" {
				path += "/snapshot"
				method = "GET"
			}
			v, e := client.request(ctx, method, path, nil)
			if e != nil {
				return e
			}
			return printJSON(v)
		}
		if sub != "list" {
			return errors.New("use list, or sessions show/delete ID")
		}
		v, e := client.request(ctx, "GET", "/api/catalog", nil)
		if e != nil {
			return e
		}
		var catalog map[string]json.RawMessage
		if json.Unmarshal(v, &catalog) != nil {
			return errors.New("invalid catalog")
		}
		return printJSON(catalog[args[0]])
	case "chat", "run":
		if *session == "" {
			return errors.New("use --session ID --message TEXT; create the session in lake web")
		}
		if *message == "" {
			*message = strings.Join(flags.Args(), " ")
		}
		if strings.TrimSpace(*message) == "" {
			return errors.New("message required")
		}
		path := "/api/sessions/" + url.PathEscape(*session)
		if _, e = client.request(ctx, "POST", path+"/messages", map[string]any{"text": *message}); e != nil {
			return e
		}
		timer := time.NewTicker(250 * time.Millisecond)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
			}
			raw, e := client.request(ctx, "GET", path+"/snapshot", nil)
			if e != nil {
				return e
			}
			var snap struct {
				Session struct {
					Status string `json:"status"`
				} `json:"session"`
				AI ai.View `json:"ai"`
			}
			if json.Unmarshal(raw, &snap) != nil {
				return errors.New("invalid snapshot")
			}
			if snap.Session.Status == "waiting_approval" || snap.AI.Pending != nil {
				return printJSON(raw)
			}
			if snap.Session.Status != "investigating" {
				for i := len(snap.AI.Cards) - 1; i >= 0; i-- {
					c := snap.AI.Cards[i]
					if c.Type == "message" {
						fmt.Println(c.Content)
						return nil
					}
				}
				return printJSON(raw)
			}
		}
	}
	return errors.New("command unavailable in the Go workbench; use lake --help")
}

const help = `Lake — Go 运维工作台（运行无需 Node.js）
  lake web [--open] [--port 4177] [--home PATH]   启动 React 工作台
  lake serve [相同参数]                        启动同一个 Go 服务
  lake open [--home PATH]                      打开已运行的工作台
  lake doctor | models [--home PATH]           查看后端或模型设置
  lake projects | resources | sessions list   查看工作台记录
  lake sessions show/delete ID                查看或删除会话
  lake chat --session ID --message TEXT        在已有会话发起 AI 轮次
  lake status                                 查看本机系统
  lake ai [--data PATH]                        Go AI stdio 接口
  lake secrets migrate --manifest FILE [--home PATH]  显式旧凭据迁移
旧版 TypeScript Agent 与 Node Web 后端源码已移除，不支持其独立 grants/tasks/workflow CLI 合约。
旧用户数据保留，不会自动导入新工作台。`

func lakeHome() string {
	if s := os.Getenv("LAKE_HOME"); s != "" {
		return s
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".lake")
}
func envPort() int {
	if s := os.Getenv("LAKE_WEB_PORT"); s != "" {
		p, e := strconv.Atoi(s)
		if e != nil {
			return -1
		}
		return p
	}
	return 4177
}
func openURL(s string) error {
	if runtime.GOOS == "windows" {
		return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", s).Run()
	}
	program := "xdg-open"
	if runtime.GOOS == "darwin" {
		program = "open"
	}
	return exec.Command(program, s).Run()
}

type apiClient struct{ origin, token string }

func connect(home string) (apiClient, error) {
	path := filepath.Join(home, "web-agent", "runtime.json")
	info, e := os.Stat(path)
	if e != nil || !platform.Private(path, info) {
		return apiClient{}, errors.New("Go workbench not running; start lake web --open")
	}
	b, e := os.ReadFile(path)
	if e != nil {
		return apiClient{}, e
	}
	var v struct{ Origin, Token string }
	if json.Unmarshal(b, &v) != nil {
		return apiClient{}, errors.New("invalid private runtime metadata")
	}
	u, e := url.Parse(v.Origin)
	if e != nil || u.Scheme != "http" || u.Hostname() != "localhost" || u.User != nil || u.RawQuery != "" || u.Path != "" || v.Token == "" {
		return apiClient{}, errors.New("invalid local runtime address")
	}
	return apiClient{v.Origin, v.Token}, nil
}
func (c apiClient) request(ctx context.Context, method, path string, data any) (json.RawMessage, error) {
	var body io.Reader
	if data != nil {
		b, e := json.Marshal(data)
		if e != nil {
			return nil, e
		}
		body = strings.NewReader(string(b))
	}
	r, e := http.NewRequestWithContext(ctx, method, c.origin+path, body)
	if e != nil {
		return nil, e
	}
	r.Header.Set("Authorization", "Bearer "+c.token)
	if data != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	httpClient := &http.Client{Timeout: 30 * time.Second}
	resp, e := httpClient.Do(r)
	if e != nil {
		return nil, errors.New("Go workbench unavailable; start lake web --open")
	}
	defer resp.Body.Close()
	b, e := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if e != nil {
		return nil, e
	}
	if resp.StatusCode >= 400 {
		var v struct{ Error string }
		json.Unmarshal(b, &v)
		if v.Error != "" {
			return nil, errors.New(v.Error)
		}
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if resp.StatusCode == 204 {
		return []byte("null"), nil
	}
	return b, nil
}
func printJSON(v json.RawMessage) error {
	var out any
	if e := json.Unmarshal(v, &out); e != nil {
		return e
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}
