//go:build windows

package main

import (
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	backgroundSubclass = 2
	trayCallback       = 0x8032
	trayShow           = 0x1f00
	trayQuit           = 0x1f10
)

var (
	backgroundProcPointer uintptr
	backgroundWindows     = map[uintptr]*backgroundWindow{} // Window thread only.
	trayNotify            = windows.NewLazySystemDLL("shell32.dll").NewProc("Shell_NotifyIconW")
	backgroundActivate    = registeredWindowMessage("CleanLakes.ShowWorkbench")
	backgroundTaskbar     = registeredWindowMessage("TaskbarCreated")
)

func init() { backgroundProcPointer = windows.NewCallback(backgroundProc) }

// Current NOTIFYICONDATAW layout, including the version-4 callback contract:
// https://learn.microsoft.com/windows/win32/api/shellapi/ns-shellapi-notifyicondataw
type trayIconData struct {
	Size                uint32
	Window              uintptr
	ID, Flags, Callback uint32
	Icon                uintptr
	Tip                 [128]uint16
	State, StateMask    uint32
	Info                [256]uint16
	Version             uint32
	InfoTitle           [64]uint16
	InfoFlags           uint32
	GUID                windows.GUID
	BalloonIcon         uintptr
}

type backgroundWindow struct {
	hwnd, systemMenu uintptr
	separator        uintptr
	marker           *uint16
	icon             trayIconData
	notify           func(uint32, *trayIconData) bool
	exit             func()
	added, quitting  bool
}

func registeredWindowMessage(name string) uintptr {
	value, _ := windows.UTF16PtrFromString(name)
	id, _, _ := themeUser.NewProc("RegisterWindowMessageW").Call(uintptr(unsafe.Pointer(value)))
	return id
}

func nativeTrayNotify(action uint32, icon *trayIconData) bool {
	ok, _, _ := trayNotify.Call(uintptr(action), uintptr(unsafe.Pointer(icon)))
	return ok != 0
}

func installBackgroundWindow(hwnd uintptr, marker string, exit func()) (*backgroundWindow, error) {
	return installBackgroundWithNotify(hwnd, marker, exit, nativeTrayNotify)
}

func installBackgroundWithNotify(hwnd uintptr, marker string, exit func(), notify func(uint32, *trayIconData) bool) (*backgroundWindow, error) {
	key, err := windows.UTF16PtrFromString(marker)
	if err != nil || backgroundActivate == 0 || backgroundTaskbar == 0 {
		return nil, fmt.Errorf("无法初始化后台窗口入口")
	}
	s := &backgroundWindow{hwnd: hwnd, marker: key, exit: exit, notify: notify}
	if ok, _, _ := themeUser.NewProc("SetPropW").Call(hwnd, uintptr(unsafe.Pointer(key)), 1); ok == 0 {
		return nil, fmt.Errorf("无法登记工作台窗口")
	}
	if ok, _, _ := themeSetSubclass.Call(hwnd, backgroundProcPointer, backgroundSubclass, 0); ok == 0 {
		themeUser.NewProc("RemovePropW").Call(hwnd, uintptr(unsafe.Pointer(key)))
		return nil, fmt.Errorf("无法设置后台窗口行为")
	}
	backgroundWindows[hwnd] = s
	name := "Lake"
	if isDevelopment() {
		name = "Lake Dev"
	}
	s.systemMenu, _, _ = themeUser.NewProc("GetSystemMenu").Call(hwnd, 0)
	s.separator, _, _ = themeUser.NewProc("GetMenuItemCount").Call(s.systemMenu)
	themeUser.NewProc("AppendMenuW").Call(s.systemMenu, 0x800, 0, 0) // MF_SEPARATOR.
	quit, _ := windows.UTF16PtrFromString("退出 " + name)
	themeUser.NewProc("AppendMenuW").Call(s.systemMenu, 0, trayQuit, uintptr(unsafe.Pointer(quit)))
	// Prefer the explicit Lake icon installed on the window. ICON_SMALL2 can
	// return a system-generated icon and hide the absence of a class small icon.
	icon, _, _ := themeUser.NewProc("SendMessageW").Call(hwnd, 0x7f, 0, 0) // WM_GETICON, ICON_SMALL.
	if icon == 0 {
		icon, _, _ = themeUser.NewProc("GetClassLongPtrW").Call(hwnd, ^uintptr(33))
	}
	if icon == 0 {
		icon, _, _ = themeUser.NewProc("SendMessageW").Call(hwnd, 0x7f, 1, 0) // ICON_BIG.
	}
	if icon == 0 {
		icon, _, _ = themeUser.NewProc("GetClassLongPtrW").Call(hwnd, ^uintptr(13)) // GCLP_HICON.
	}
	if icon == 0 {
		icon, _, _ = themeUser.NewProc("LoadIconW").Call(0, 32512) // Shared fallback for test/non-packaged windows.
	}
	s.icon = trayIconData{Window: hwnd, ID: 1, Flags: 1 | 2 | 4 | 0x80, Callback: trayCallback, Icon: icon}
	s.icon.Size = uint32(unsafe.Sizeof(s.icon))
	tip, _ := windows.UTF16FromString(name)
	copy(s.icon.Tip[:], tip)
	s.addIcon()
	return s, nil
}

func (s *backgroundWindow) addIcon() {
	s.added = s.notify(0, &s.icon) // NIM_ADD. Explorer may be unavailable.
	if s.added {
		s.icon.Version = 4
		if !s.notify(4, &s.icon) { // NIM_SETVERSION.
			s.notify(2, &s.icon)
			s.added = false
		}
	}
}

func (s *backgroundWindow) show() {
	if s.quitting {
		return
	}
	minimized, _, _ := themeUser.NewProc("IsIconic").Call(s.hwnd)
	if minimized != 0 {
		themeUser.NewProc("ShowWindow").Call(s.hwnd, 9) // SW_RESTORE preserves the normal placement.
	} else {
		themeUser.NewProc("ShowWindow").Call(s.hwnd, 5) // SW_SHOW preserves maximization.
	}
	themeUser.NewProc("SetForegroundWindow").Call(s.hwnd)
}

func (s *backgroundWindow) hide() {
	mode := uintptr(0) // SW_HIDE, with a recoverable tray entry.
	if !s.added {
		mode = 6
	} // SW_MINIMIZE keeps a taskbar entry when Explorer's tray is unavailable.
	themeUser.NewProc("ShowWindow").Call(s.hwnd, mode)
}

func (s *backgroundWindow) command(command uintptr) {
	switch command {
	case trayShow:
		s.show()
	case trayQuit:
		if !s.quitting {
			s.quitting = true
			s.exit() // Same message-loop exit and backend cleanup as the updater.
		}
	}
}

func (s *backgroundWindow) menu() {
	menu, _, _ := themeUser.NewProc("CreatePopupMenu").Call()
	if menu == 0 {
		return
	}
	defer themeUser.NewProc("DestroyMenu").Call(menu)
	for _, item := range []struct {
		id    uintptr
		title string
	}{{trayShow, "显示工作台"}, {trayQuit, "退出 Lake"}} {
		if item.id == trayQuit && isDevelopment() {
			item.title = "退出 Lake Dev"
		}
		title, _ := windows.UTF16PtrFromString(item.title)
		themeUser.NewProc("AppendMenuW").Call(menu, 0, item.id, uintptr(unsafe.Pointer(title)))
	}
	var point windowPoint
	themeUser.NewProc("GetCursorPos").Call(uintptr(unsafe.Pointer(&point)))
	themeUser.NewProc("SetForegroundWindow").Call(s.hwnd)
	selected, _, _ := themeUser.NewProc("TrackPopupMenu").Call(menu, 0x180, uintptr(point.X), uintptr(point.Y), 0, s.hwnd, 0)
	themeUser.NewProc("PostMessageW").Call(s.hwnd, 0, 0, 0) // WM_NULL lets a dismissed menu release focus.
	s.command(selected)
}

func (s *backgroundWindow) close() {
	if backgroundWindows[s.hwnd] != s {
		return
	}
	delete(backgroundWindows, s.hwnd)
	if s.added {
		s.notify(2, &s.icon)
		s.added = false
	}
	themeUser.NewProc("RemovePropW").Call(s.hwnd, uintptr(unsafe.Pointer(s.marker)))
	themeUser.NewProc("RemoveMenu").Call(s.systemMenu, trayQuit, 0)
	themeUser.NewProc("RemoveMenu").Call(s.systemMenu, s.separator, 0x400)
	themeRemoveSubclass.Call(s.hwnd, backgroundProcPointer, backgroundSubclass)
}

func backgroundProc(hwnd, msg, wp, lp, id, ref uintptr) uintptr {
	if s := backgroundWindows[hwnd]; s != nil {
		switch msg {
		case windowClose:
			if !s.quitting {
				s.hide()
				return 0
			}
		case backgroundActivate:
			s.show()
			return 0
		case backgroundTaskbar:
			if s.quitting {
				return 0
			}
			visible, _, _ := themeUser.NewProc("IsWindowVisible").Call(hwnd)
			s.added = false
			s.addIcon()
			if !s.added && visible == 0 {
				s.hide()
			}
			return 0
		case trayCallback:
			if uint16(lp>>16) != uint16(s.icon.ID) {
				return 0
			}
			switch uint16(lp) {
			case 0x400, 0x401, 0x203: // NIN_SELECT, NIN_KEYSELECT, WM_LBUTTONDBLCLK.
				s.show()
			case 0x7b: // WM_CONTEXTMENU; Shell version 4 also supports keyboard use.
				s.menu()
			}
			return 0
		case windowCommand:
			if wp&0xfff0 == trayQuit {
				s.command(trayQuit)
				return 0
			}
		case 0x16: // WM_ENDSESSION: explicit OS session shutdown is a real exit.
			if wp != 0 {
				s.command(trayQuit)
			}
		case 0x82: // WM_NCDESTROY.
			s.close()
		}
	}
	r, _, _ := themeDefSubclass.Call(hwnd, msg, wp, lp)
	return r
}

// A second launch activates the window for this exact data home. It never
// starts another backend, reads credentials, or targets another Dev/profile.
func activateExistingWindow(marker string) bool {
	for attempt := 0; attempt < 100; attempt++ {
		if hwnd := existingBackgroundWindow(marker); hwnd != 0 {
			var pid uint32
			themeUser.NewProc("GetWindowThreadProcessId").Call(hwnd, uintptr(unsafe.Pointer(&pid)))
			themeUser.NewProc("AllowSetForegroundWindow").Call(uintptr(pid))
			ok, _, _ := themeUser.NewProc("PostMessageW").Call(hwnd, backgroundActivate, 0, 0)
			return ok != 0
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

func existingBackgroundWindow(marker string) uintptr {
	key, err := windows.UTF16PtrFromString(marker)
	if err != nil {
		return 0
	}
	for hwnd, count := uintptr(0), 0; count < 10000; count++ {
		hwnd, _, _ = themeUser.NewProc("FindWindowExW").Call(0, hwnd, 0, 0)
		if hwnd == 0 {
			return 0
		}
		found, _, _ := themeUser.NewProc("GetPropW").Call(hwnd, uintptr(unsafe.Pointer(key)))
		if found != 0 {
			return hwnd
		}
	}
	return 0
}
