//go:build windows

package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
	"time"
	"unsafe"

	webview "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

func startupCloaked(t *testing.T, hwnd uintptr) bool {
	t.Helper()
	var state uint32
	result, _, _ := windows.NewLazySystemDLL("dwmapi.dll").NewProc("DwmGetWindowAttribute").Call(hwnd, 14, uintptr(unsafe.Pointer(&state)), 4)
	if int32(result) < 0 {
		t.Fatalf("cannot read DWM startup visibility: %x", result)
	}
	return state&1 != 0 // DWM_CLOAKED_APP, not virtual-desktop shell cloaking.
}

func TestWindowsStartupNeverShowsTheInitialNativeCaption(t *testing.T) {
	runtime.LockOSThread()
	t.Cleanup(runtime.UnlockOSThread)
	startup, err := beginWindowStartup("LakeCaptionTest-" + t.Name())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(startup.close)
	hwnd := themeTestWindow(t, false) // Creates and shows a real native caption.
	if err := startup.created(hwnd); err != nil {
		t.Fatal(err)
	}
	if !startupCloaked(t, hwnd) {
		t.Fatal("the constructor's first ShowWindow exposed the native caption")
	}
	if err := startup.reveal(); err == nil {
		t.Fatal("unprepared caption was allowed to become visible")
	}
	if !startupCloaked(t, hwnd) {
		t.Fatal("rejecting an early reveal uncloaked the window")
	}
	if err := extendWorkbenchIntoTitleBar(hwnd); err != nil {
		t.Fatal(err)
	}
	if err := startup.reveal(); err != nil {
		t.Fatal(err)
	}
	if startupCloaked(t, hwnd) {
		t.Fatal("the prepared workbench did not become visible")
	}
	themeUser.NewProc("ShowWindow").Call(hwnd, 0)
	if err := startup.reveal(); err != nil {
		t.Fatal(err)
	}
	visible, _, _ := themeUser.NewProc("IsWindowVisible").Call(hwnd)
	if visible != 0 {
		t.Fatal("duplicate ready restored a window the user put in the tray")
	}
	if _, exists := startupHooks.Load(startup.threadID); exists {
		t.Fatal("window construction retained its thread hook")
	}
}

func TestWindowsStartupDoesNotCloakUnrelatedWindows(t *testing.T) {
	runtime.LockOSThread()
	t.Cleanup(runtime.UnlockOSThread)
	startup, err := beginWindowStartup("another-window-class")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(startup.close)
	hwnd := themeTestWindow(t, false)
	if startupCloaked(t, hwnd) || startup.hwnd != 0 {
		t.Fatal("startup intercepted a window outside its class")
	}
	if err := startup.created(hwnd); err == nil {
		t.Fatal("an uncaptured window silently bypassed startup preparation")
	}
}

func TestWindowsStartupRevealsAfterRealWebViewWorkbenchCommit(t *testing.T) {
	if _, err := webviewloader.GetInstalledVersion(); err != nil {
		t.Skip("WebView2 runtime is not installed")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><html><body><div class="gate-shell startup-loading" id="root">Loading</div><script>setTimeout(()=>{document.getElementById('root').className='app-shell';document.getElementById('root').textContent='Lake';},250);</script></body></html>`)
	}))
	defer server.Close()
	startup, err := beginWindowStartup("webview")
	if err != nil {
		t.Fatal(err)
	}
	defer startup.close()
	window := webview.NewWithOptions(webview.WebViewOptions{DataPath: t.TempDir(), WindowOptions: webview.WindowOptions{Title: "Lake startup regression", Width: 400, Height: 280}})
	if window == nil {
		t.Fatal("WebView2 window creation failed")
	}
	defer window.Destroy()
	if err := startup.created(uintptr(window.Window())); err != nil {
		t.Fatal(err)
	}
	if !startupCloaked(t, uintptr(window.Window())) {
		t.Fatal("WebView2 constructor exposed its initial blank/native window")
	}
	if err := extendWorkbenchIntoTitleBar(uintptr(window.Window())); err != nil {
		t.Fatal(err)
	}
	var readyErr error
	var readyAt time.Time
	if err := installWindowsChrome(window, server.URL, func() error {
		readyAt = time.Now()
		readyErr = startup.reveal()
		if readyErr == nil && startupCloaked(t, uintptr(window.Window())) {
			readyErr = fmt.Errorf("ready did not reveal the window")
		}
		window.Destroy()
		return readyErr
	}); err != nil {
		t.Fatal(err)
	}
	deadline := time.AfterFunc(10*time.Second, func() { window.Dispatch(window.Destroy) })
	defer deadline.Stop()
	started := time.Now()
	window.Navigate(server.URL)
	window.Run()
	if readyErr != nil {
		t.Fatal(readyErr)
	}
	if readyAt.IsZero() || readyAt.Sub(started) < 200*time.Millisecond {
		t.Fatal("window did not wait for the workbench to replace the loading screen")
	}
}
