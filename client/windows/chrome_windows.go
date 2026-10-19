//go:build windows

package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"

	webview "github.com/jchv/go-webview2"
)

const (
	windowStyleIndex = ^uintptr(15) // GWL_STYLE (-16).
	windowCaption    = 0x00c00000   // WS_CAPTION; keep WS_THICKFRAME and system-menu styles.
	frameChanged     = 0x0037       // FRAMECHANGED | NOMOVE | NOSIZE | NOZORDER | NOACTIVATE.
	windowClose      = 0x0010       // WM_CLOSE.
	windowCommand    = 0x0112       // WM_SYSCOMMAND.
	windowDrag       = 0x00a1       // WM_NCLBUTTONDOWN.
	captionHit       = 2            // HTCAPTION.
	scMinimize       = 0xf020
	scMaximize       = 0xf030
	scRestore        = 0xf120
)

// The WebView occupies the same client area as the workbench header. Windows
// keeps its resize frame and system commands; only the separate caption is
// removed, so the React header can be the visible title bar.
func extendWorkbenchIntoTitleBar(hwnd uintptr) error {
	style, _, _ := themeUser.NewProc("GetWindowLongPtrW").Call(hwnd, windowStyleIndex)
	if style == 0 {
		return fmt.Errorf("无法读取窗口样式")
	}
	previous, _, err := themeUser.NewProc("SetWindowLongPtrW").Call(hwnd, windowStyleIndex, style&^windowCaption)
	if previous == 0 {
		return fmt.Errorf("无法合并窗口标题栏：%w", err)
	}
	ok, _, err := themeUser.NewProc("SetWindowPos").Call(hwnd, 0, 0, 0, 0, 0, frameChanged)
	if ok == 0 {
		return fmt.Errorf("无法刷新窗口边框：%w", err)
	}
	return nil
}

func installWindowsChrome(window webview.WebView, endpoint string, onReady func() error) error {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return err
	}
	capability := make([]byte, 32)
	if _, err = rand.Read(capability); err != nil {
		return err
	}
	token := hex.EncodeToString(capability)
	if err = window.Bind("__lakeWindowsChrome", func(provided, action string) (string, error) {
		if subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
			return "", fmt.Errorf("窗口操作无效")
		}
		switch action {
		case "state":
			zoomed, _, _ := themeUser.NewProc("IsZoomed").Call(uintptr(window.Window()))
			if zoomed != 0 {
				return "maximized", nil
			}
			return "normal", nil
		case "drag", "minimize", "maximize", "close", "ready":
		default:
			return "", fmt.Errorf("窗口操作无效")
		}
		window.Dispatch(func() {
			hwnd := uintptr(window.Window())
			switch action {
			case "ready":
				_ = onReady()
			case "drag":
				themeUser.NewProc("ReleaseCapture").Call()
				themeUser.NewProc("SendMessageW").Call(hwnd, windowDrag, captionHit, 0)
			case "minimize":
				themeUser.NewProc("PostMessageW").Call(hwnd, windowCommand, scMinimize, 0)
			case "maximize":
				zoomed, _, _ := themeUser.NewProc("IsZoomed").Call(hwnd)
				command := uintptr(scMaximize)
				if zoomed != 0 {
					command = scRestore
				}
				themeUser.NewProc("PostMessageW").Call(hwnd, windowCommand, command, 0)
			case "close":
				themeUser.NewProc("PostMessageW").Call(hwnd, windowClose, 0, 0)
			}
		})
		return "", nil
	}); err != nil {
		return err
	}
	origin, _ := json.Marshal(parsed.Scheme + "://" + parsed.Host)
	secret, _ := json.Marshal(token)
	window.Init(fmt.Sprintf(`(()=>{if(window.top!==window||location.origin!==%s)return;const invoke=window.__lakeWindowsChrome;const token=%s;Object.defineProperty(window,'lakeWindowsChrome',{value:Object.freeze({command:action=>invoke(token,action)}),writable:false});%s})();`, origin, secret, workbenchReadyScript))
	return nil
}
