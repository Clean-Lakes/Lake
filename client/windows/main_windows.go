//go:build windows

package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"time"
	"unsafe"

	webassets "github.com/Clean-Lakes/Lake/assets/web"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/web"
	webview "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

// Release builds inject the repository VERSION through -ldflags and leave
// main.development empty; local dev builds set both (scripts/build_lake_windows.py --dev).
var version = "0.3.19"

func message(text string) {
	title, _ := windows.UTF16PtrFromString("Lake")
	body, _ := windows.UTF16PtrFromString(text)
	windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), 0x10)
}

func main() {
	if len(os.Args) == 3 && os.Args[1] == "--install-update" {
		if err := runUpdateHelper(os.Args[2]); err != nil {
			message(err.Error())
			os.Exit(1)
		}
		return
	}
	// Git OpenSSH invokes the same executable through a private inherited pipe.
	if os.Getenv("LAKE_SSH_ASKPASS") == "1" {
		if len(os.Args) != 2 || web.SSHAskpass(os.Args[1], os.Stdout) != nil {
			fmt.Fprintln(os.Stderr, web.SSHAskpassFailureMessage)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--check-webview" {
		if _, err := webviewloader.GetInstalledVersion(); err != nil {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println(windowTitle() + " · Windows x86_64")
		return
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := run(); err != nil {
		message(err.Error())
	}
}

func run() error {
	user, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("无法读取用户目录")
	}
	home, err := profileHome(user)
	if err != nil {
		return err
	}
	os.Setenv("LAKE_HOME", home)
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	os.Setenv("LAKE_PORTABLE_ROOT", filepath.Join(filepath.Dir(exe), "resources", "git"))
	for _, name := range []string{"/bin/sh", "ssh"} {
		if _, err = os.Stat(platform.Executable(name)); err != nil {
			return fmt.Errorf("应用缺少 Bash/SSH 运行环境，请重新安装完整软件包")
		}
	}
	if _, err = webviewloader.GetInstalledVersion(); err != nil {
		return fmt.Errorf("需要 Microsoft Edge WebView2 Runtime，请运行 Lake 安装程序，或从 Microsoft 官网安装后重试")
	}
	digest := sha256.Sum256([]byte(home))
	marker := fmt.Sprintf("CleanLakes.Workbench.%x", digest[:12])
	name, _ := windows.UTF16PtrFromString(fmt.Sprintf("Local\\CleanLakes-%x", digest[:12]))
	mutex, err := windows.CreateMutex(nil, false, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		if mutex != 0 {
			windows.CloseHandle(mutex)
		}
		if activateExistingWindow(marker) {
			return nil
		}
		return fmt.Errorf("Lake 已在运行，请切换到已有窗口")
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(mutex)
	data := filepath.Join(home, "web-agent")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server, err := web.New(ctx, web.Options{Home: home, DataDir: data, Port: 0, DynamicPort: true, Static: webassets.Files(), Output: io.Discard})
	if err != nil {
		return fmt.Errorf("Lake 后台无法启动。若此数据目录已有独立后台，请先关闭它再启动客户端。")
	}
	defer server.Close()
	done := make(chan error, 1)
	go func() { done <- server.Start() }()
	endpoint, err := awaitRuntime(ctx, data, os.Getpid(), done)
	if err != nil {
		return err
	}
	profile := filepath.Join(home, "windows-webview")
	if err = platform.MkdirAll(profile, 0700); err != nil {
		return err
	}
	width, height, minimumWidth, minimumHeight := workbenchGeometry()
	startup, err := beginWindowStartup("webview")
	if err != nil {
		return err
	}
	defer startup.close()
	window := webview.NewWithOptions(webview.WebViewOptions{DataPath: profile, AutoFocus: true, WindowOptions: webview.WindowOptions{Title: windowTitle(), Width: uint(width), Height: uint(height), Center: true, IconId: 1}})
	if window == nil {
		return fmt.Errorf("无法创建 WebView2 窗口，请检查运行环境")
	}
	if err = startup.created(uintptr(window.Window())); err != nil {
		window.Destroy()
		return err
	}
	icons, err := installApplicationIcons(uintptr(window.Window()))
	if err != nil {
		window.Destroy()
		return err
	}
	defer func() {
		window.Destroy()
		icons.close()
	}()
	if err = applyWindowColors(window.Window()); err != nil {
		return err
	}
	if err = extendWorkbenchIntoTitleBar(uintptr(window.Window())); err != nil {
		return err
	}
	background, err := installBackgroundWindow(uintptr(window.Window()), marker, window.Terminate)
	if err != nil {
		return err
	}
	defer background.close()
	var startupFailure error
	var startupTimer *time.Timer
	if err = installWindowsChrome(window, endpoint, func() error {
		if err := startup.reveal(); err != nil {
			startupFailure = err
			window.Terminate()
			return err
		}
		if startupTimer != nil {
			startupTimer.Stop()
		}
		return nil
	}); err != nil {
		return fmt.Errorf("无法初始化窗口操作")
	}
	if err = installUpdateBridge(ctx, window, endpoint, home, exe); err != nil {
		return fmt.Errorf("无法初始化客户端更新入口")
	}
	window.SetSize(minimumWidth, minimumHeight, webview.HintMin)
	if isDevelopment() {
		window.Init(developmentBadge)
	}
	startupTimer = time.AfterFunc(30*time.Second, func() {
		window.Dispatch(func() {
			if !startup.shown {
				startupFailure = fmt.Errorf("工作台加载超时，请重新启动 Lake")
				window.Terminate()
			}
		})
	})
	defer startupTimer.Stop()
	window.Navigate(endpoint)
	window.Run()
	return startupFailure
}

func awaitRuntime(ctx context.Context, data string, pid int, done <-chan error) (string, error) {
	client := &http.Client{Timeout: time.Second}
	for i := 0; i < 100; i++ {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-done:
			return "", fmt.Errorf("Lake 后台已停止，无法加载工作台")
		default:
		}
		path := filepath.Join(data, "runtime.json")
		info, err := os.Stat(path)
		if err == nil && platform.Private(path, info) {
			var state struct {
				Origin, Token string
				PID           int
			}
			b, err := os.ReadFile(path)
			if err == nil && json.Unmarshal(b, &state) == nil && state.PID == pid && state.Token != "" {
				u, err := url.Parse(state.Origin)
				if err == nil && u.Scheme == "http" && u.Hostname() == "localhost" && u.Port() != "" && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == "" {
					request, _ := http.NewRequestWithContext(ctx, "GET", state.Origin+"/api/bootstrap", nil)
					request.Header.Set("Authorization", "Bearer "+state.Token)
					response, err := client.Do(request)
					if err == nil {
						response.Body.Close()
						if response.StatusCode == 200 {
							u.Fragment = "token=" + state.Token
							return u.String(), nil
						}
					}
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return "", fmt.Errorf("Lake 后台启动超时")
}
