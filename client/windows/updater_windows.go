//go:build windows

package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unsafe"

	"github.com/Clean-Lakes/Lake/internal/desktopupdate"
	"github.com/Clean-Lakes/Lake/internal/platform"
	webview "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

type updateState struct {
	UpdateAvailable bool   `json:"updateAvailable"`
	ReleaseNotes    string `json:"releaseNotes,omitempty"`
	Status          string `json:"status"`
	CurrentVersion  string `json:"currentVersion"`
	Version         string `json:"version,omitempty"`
	Message         string `json:"message"`
	Progress        *int   `json:"progress,omitempty"`
}
type windowsUpdater struct {
	mu        sync.Mutex
	ctx       context.Context
	client    *http.Client
	window    webview.WebView
	home, exe string
	state     updateState
	available *desktopupdate.Update
	busy      bool
}

func installUpdateBridge(ctx context.Context, window webview.WebView, endpoint, home, exe string) error {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return err
	}
	capability := make([]byte, 32)
	if _, err = rand.Read(capability); err != nil {
		return err
	}
	token := hex.EncodeToString(capability)
	message := "检查 GitHub master 的 Windows 正式版本"
	if isDevelopment() {
		message = developmentUpdateMessage
	}
	u := &windowsUpdater{ctx: ctx, client: desktopupdate.NewHTTPClient(), window: window, home: home, exe: exe, state: updateState{Status: "idle", CurrentVersion: version, Message: message}}
	go func() {
		root := filepath.Join(home, "updates", "windows")
		for attempt := 0; attempt < 30; attempt++ {
			_ = desktopupdate.CleanupCompletedJobs(root, version)
			timer := time.NewTimer(time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
	if err = window.Bind("__lakeWindowsUpdate", func(provided, action string) (updateState, error) {
		if subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
			return updateState{}, fmt.Errorf("更新入口无效")
		}
		switch action {
		case "state":
		case "check":
			u.check()
		case "install":
			u.install()
		default:
			return updateState{}, fmt.Errorf("更新操作无效")
		}
		return u.snapshot(), nil
	}); err != nil {
		return err
	}
	origin, _ := json.Marshal(parsed.Scheme + "://" + parsed.Host)
	secret, _ := json.Marshal(token)
	// Keep the random capability inside a closure, and expose it only to the
	// authenticated local main frame. Navigated external pages cannot call it.
	// The workbench reads platform and development for its update labels, and a
	// development build refuses to install a release over itself.
	window.Init(fmt.Sprintf(`(()=>{if(window.top!==window||location.origin!==%s)return;const invoke=window.__lakeWindowsUpdate;const token=%s;Object.defineProperty(window,'lakeWindowsDesktop',{value:Object.freeze({platform:'Windows x86_64',development:%t,command:action=>invoke(token,action)}),writable:false});})();`, origin, secret, isDevelopment()))
	if isDevelopment() {
		return nil
	}
	go func() {
		timer := time.NewTimer(3 * time.Second)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			u.check()
		}
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				u.check()
			}
		}
	}()
	return nil
}
func (u *windowsUpdater) snapshot() updateState { u.mu.Lock(); defer u.mu.Unlock(); return u.state }
func (u *windowsUpdater) publish(status, message string, progress *int) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.state.Status = status
	u.state.Message = message
	u.state.Progress = progress
}
func (u *windowsUpdater) check() {
	_ = desktopupdate.CleanupCompletedJobs(filepath.Join(u.home, "updates", "windows"), u.snapshot().CurrentVersion)
	u.mu.Lock()
	if u.busy {
		u.mu.Unlock()
		return
	}
	u.busy = true
	u.state.Status = "checking"
	u.state.Message = "正在检查 master 的 Windows 正式版本…"
	u.state.Progress = nil
	u.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(u.ctx, 30*time.Second)
		defer cancel()
		update, notes, err := desktopupdate.CheckWithNotes(ctx, u.client, version)
		u.mu.Lock()
		defer u.mu.Unlock()
		u.busy = false
		if err != nil {
			u.state.Status = "error"
			u.state.Message = err.Error()
			return
		}
		u.available = update
		u.state.UpdateAvailable = update != nil
		u.state.ReleaseNotes = notes
		if update == nil {
			u.state.Version = ""
			u.state.Status = "current"
			u.state.Message = "当前已是最新的 Windows 兼容版本"
			return
		}
		u.state.Status = "available"
		u.state.Version = update.Version
		u.state.ReleaseNotes = update.ReleaseNotes
		u.state.Message = "发现 Lake " + update.Version + "，可以下载并安装"
	}()
}
func (u *windowsUpdater) install() {
	if isDevelopment() {
		// Like the macOS Dev app, a development build updates through local builds:
		// installing a release package would replace the development client.
		u.publish("idle", developmentUpdateMessage, nil)
		return
	}
	u.mu.Lock()
	if u.busy || u.available == nil {
		u.mu.Unlock()
		return
	}
	update := *u.available
	u.busy = true
	u.mu.Unlock()
	title, _ := windows.UTF16PtrFromString("安装 Lake 更新")
	body, _ := windows.UTF16PtrFromString("下载并安装 Lake " + update.Version + "？\n\n安装会关闭当前终端连接，更新后自动重新打开。用户数据和配置会保留。\n免安装版更新后会使用用户目录中的安装版。")
	answer, _, _ := themeUser.NewProc("MessageBoxW").Call(uintptr(u.window.Window()), uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), 0x124) // YESNO | ICONINFORMATION | default NO.
	if answer != 6 {
		u.mu.Lock()
		u.busy = false
		u.mu.Unlock()
		return
	}
	go func() {
		if err := u.downloadAndInstall(update); err != nil {
			u.publish("error", err.Error(), nil)
		}
		u.mu.Lock()
		u.busy = false
		u.mu.Unlock()
	}()
}
func (u *windowsUpdater) downloadAndInstall(update desktopupdate.Update) error {
	root := filepath.Join(u.home, "updates", "windows")
	if err := platform.MkdirAll(root, 0700); err != nil {
		return fmt.Errorf("无法创建更新缓存目录")
	}
	work, err := os.MkdirTemp(root, "job-")
	if err != nil {
		return fmt.Errorf("无法创建更新任务")
	}
	if err = platform.Chmod(work, 0700); err != nil {
		os.RemoveAll(work)
		return fmt.Errorf("无法保护更新目录")
	}
	handedOff := false
	defer func() {
		if !handedOff {
			os.RemoveAll(work)
		}
	}()
	installer := filepath.Join(work, update.Installer.Name)
	file, err := platform.OpenFile(installer, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("无法保存更新安装包")
	}
	zero := 0
	u.publish("downloading", "正在下载安装包…", &zero)
	ctx, cancel := context.WithTimeout(u.ctx, 20*time.Minute)
	defer cancel()
	sum, err := desktopupdate.Download(ctx, u.client, update, file, func(progress int) { u.publish("downloading", "正在下载安装包…", &progress) })
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return fmt.Errorf("无法写入更新安装包")
	}
	u.publish("verifying", "安装包已下载，正在准备更新…", nil)
	if err = startUpdateHelper(work, u.home, u.exe, update, sum); err != nil {
		return err
	}
	handedOff = true
	u.publish("installing", "即将退出，安装完成后自动重新打开…", nil)
	u.window.Dispatch(func() { u.window.Terminate() })
	return nil
}
