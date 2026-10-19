//go:build windows

package main

import (
	"fmt"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	startupHookCallback = windows.NewCallback(startupCreateWindow)
	startupHooks        sync.Map // UI thread ID -> *windowStartup.
)

// go-webview2 shows its HWND before NewWithOptions returns. Cloak the exact
// window during WM_CREATE so that first ShowWindow cannot paint a caption.
// DWM continues composing the window while React prepares the workbench.
// https://learn.microsoft.com/windows/win32/winmsg/callwndproc
type windowStartup struct {
	className string
	threadID  uint32
	hook      uintptr
	hwnd      uintptr
	shown     bool
	err       error
}

func beginWindowStartup(className string) (*windowStartup, error) {
	s := &windowStartup{className: className, threadID: windows.GetCurrentThreadId()}
	if _, exists := startupHooks.LoadOrStore(s.threadID, s); exists {
		return nil, fmt.Errorf("窗口启动已在准备中")
	}
	hook, _, err := themeUser.NewProc("SetWindowsHookExW").Call(4, startupHookCallback, 0, uintptr(s.threadID)) // WH_CALLWNDPROC; this thread only.
	if hook == 0 {
		startupHooks.Delete(s.threadID)
		return nil, fmt.Errorf("无法准备工作台窗口：%w", err)
	}
	s.hook = hook
	return s, nil
}

type startupWindowMessage struct {
	Data, Param uintptr
	Message     uint32
	Window      uintptr
}

func startupCreateWindow(code, param, data uintptr) uintptr {
	if int32(code) >= 0 && data != 0 {
		message := *(**startupWindowMessage)(unsafe.Pointer(&data))
		if message.Message != 1 { // WM_CREATE; the HWND is now valid to DWM.
			result, _, _ := themeUser.NewProc("CallNextHookEx").Call(0, code, param, data)
			return result
		}
		hwnd := message.Window
		if value, ok := startupHooks.Load(windows.GetCurrentThreadId()); ok {
			s := value.(*windowStartup)
			var name [256]uint16
			themeUser.NewProc("GetClassNameW").Call(hwnd, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)))
			if s.hwnd == 0 && windows.UTF16ToString(name[:]) == s.className {
				s.hwnd = hwnd
				if !setDWM(hwnd, 13, 1) { // DWMWA_CLOAK, supported by Windows 10/11.
					s.err = fmt.Errorf("无法隐藏工作台的启动窗口")
				}
			}
		}
	}
	result, _, _ := themeUser.NewProc("CallNextHookEx").Call(0, code, param, data)
	return result
}

func (s *windowStartup) close() {
	if s.hook != 0 {
		themeUser.NewProc("UnhookWindowsHookEx").Call(s.hook)
		s.hook = 0
		startupHooks.Delete(s.threadID)
	}
}

func (s *windowStartup) created(hwnd uintptr) error {
	s.close()
	if s.err != nil {
		return s.err
	}
	if s.hwnd == 0 || s.hwnd != hwnd {
		return fmt.Errorf("工作台窗口未完成启动准备")
	}
	return nil
}

func (s *windowStartup) reveal() error {
	if s.shown {
		return nil // Reloading must not restore a window the user put in the tray.
	}
	style, _, _ := themeUser.NewProc("GetWindowLongPtrW").Call(s.hwnd, windowStyleIndex)
	if style&windowCaption != 0 {
		return fmt.Errorf("工作台标题栏尚未准备完成")
	}
	if !setDWM(s.hwnd, 13, 0) {
		return fmt.Errorf("无法显示工作台窗口")
	}
	s.shown = true
	themeUser.NewProc("ShowWindow").Call(s.hwnd, 5)
	themeUser.NewProc("SetForegroundWindow").Call(s.hwnd)
	return nil
}

// Wait for the app or a usable connection/authentication error to commit.
// The timer only handles animation-frame throttling of an occluded WebView.
const workbenchReadyScript = `
const watchWorkbench = () => {
  let sent = false;
  const observer = new MutationObserver(check);
  function check() {
    if (sent || !document.querySelector('.app-shell,.gate-shell:not(.startup-loading)')) return;
    sent = true;
    observer.disconnect();
    let delivered = false;
    const ready = () => {
      if (delivered) return;
      delivered = true;
      invoke(token, 'ready').catch(() => {});
    };
    requestAnimationFrame(() => requestAnimationFrame(ready));
    setTimeout(ready, 150);
  }
  observer.observe(document.documentElement, {childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  check();
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchWorkbench, {once:true});
else watchWorkbench();
`
