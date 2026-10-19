//go:build windows

package main

import (
	"testing"
	"unsafe"
)

func backgroundFixture(t *testing.T, available bool) (uintptr, *backgroundWindow, *int, *int) {
	t.Helper()
	hwnd := themeTestWindow(t, false)
	adds, exits := new(int), new(int)
	s, err := installBackgroundWithNotify(hwnd, "LakeBackgroundTest-"+t.Name(), func() { *exits++ }, func(action uint32, icon *trayIconData) bool {
		if action == 0 {
			*adds++
		}
		return available
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.close)
	return hwnd, s, adds, exits
}

func TestWindowsCloseKeepsWindowAliveAndTrayReopensIt(t *testing.T) {
	hwnd, s, _, exits := backgroundFixture(t, true)
	for i := 0; i < 3; i++ {
		themeUser.NewProc("SendMessageW").Call(hwnd, windowClose, 0, 0)
		alive, _, _ := themeUser.NewProc("IsWindow").Call(hwnd)
		visible, _, _ := themeUser.NewProc("IsWindowVisible").Call(hwnd)
		if alive == 0 || visible != 0 || *exits != 0 {
			t.Fatal("close destroyed the background window or exited the backend owner")
		}
		themeUser.NewProc("SendMessageW").Call(hwnd, trayCallback, 0, uintptr(s.icon.ID)<<16|0x401)
		visible, _, _ = themeUser.NewProc("IsWindowVisible").Call(hwnd)
		if visible == 0 {
			t.Fatal("keyboard tray activation did not reopen the retained window")
		}
	}
	s.command(trayQuit)
	s.command(trayQuit)
	if *exits != 1 {
		t.Fatal("explicit quit must exit exactly once")
	}
	themeUser.NewProc("SendMessageW").Call(hwnd, windowClose, 0, 0)
	if _, exists := backgroundWindows[hwnd]; exists {
		t.Fatal("explicit close retained tray/window state")
	}
}

func TestWindowsMissingTrayMinimizesAndStillHasExplicitExit(t *testing.T) {
	hwnd, s, _, exits := backgroundFixture(t, false)
	themeUser.NewProc("SendMessageW").Call(hwnd, windowClose, 0, 0)
	minimized, _, _ := themeUser.NewProc("IsIconic").Call(hwnd)
	visible, _, _ := themeUser.NewProc("IsWindowVisible").Call(hwnd)
	if minimized == 0 || visible == 0 || *exits != 0 {
		t.Fatal("no-tray fallback stranded or terminated the window")
	}
	s.command(trayShow)
	minimized, _, _ = themeUser.NewProc("IsIconic").Call(hwnd)
	if minimized != 0 {
		t.Fatal("restore left window minimized")
	}
	themeUser.NewProc("SendMessageW").Call(hwnd, windowCommand, trayQuit, 0)
	if *exits != 1 {
		t.Fatal("system-menu exit did not terminate")
	}
}

func TestWindowsBackgroundReopenPreservesMaximizedState(t *testing.T) {
	hwnd, s, _, _ := backgroundFixture(t, true)
	if err := extendWorkbenchIntoTitleBar(hwnd); err != nil {
		t.Fatal(err)
	}
	themeUser.NewProc("SendMessageW").Call(hwnd, windowCommand, scMaximize, 0)
	themeUser.NewProc("SendMessageW").Call(hwnd, windowClose, 0, 0)
	s.command(trayShow)
	maximized, _, _ := themeUser.NewProc("IsZoomed").Call(hwnd)
	if maximized == 0 {
		t.Fatal("reopening changed the maximized window into a normal window")
	}
}

func TestWindowsTaskbarRestartRestoresTrayAndCleansUp(t *testing.T) {
	hwnd, s, adds, exits := backgroundFixture(t, true)
	themeUser.NewProc("SendMessageW").Call(hwnd, windowClose, 0, 0)
	themeUser.NewProc("SendMessageW").Call(hwnd, backgroundTaskbar, 0, 0)
	if *adds != 2 || !s.added || *exits != 0 {
		t.Fatal("Explorer restart did not restore tray state")
	}
	themeUser.NewProc("SendMessageW").Call(hwnd, 0x16, 1, 0)
	if *exits != 1 {
		t.Fatal("session shutdown was treated as close-to-background")
	}
	s.close()
	s.close()
	if existingBackgroundWindow("LakeBackgroundTest-"+t.Name()) != 0 {
		t.Fatal("cleanup retained the activation marker")
	}
}

func TestWindowsBackgroundActivationIsScopedToDataHome(t *testing.T) {
	hwnd, _, _, _ := backgroundFixture(t, true)
	marker := "LakeBackgroundTest-" + t.Name()
	if existingBackgroundWindow(marker) != hwnd || existingBackgroundWindow(marker+"-another-home") != 0 {
		t.Fatal("activation crossed profile boundaries")
	}
	if !activateExistingWindow(marker) {
		t.Fatal("second launch could not signal the existing window")
	}
}

func TestWindowsNativeTrayRegistrationAndCallbackLayout(t *testing.T) {
	if unsafe.Sizeof(trayIconData{}) != 976 {
		t.Fatal("NOTIFYICONDATAW layout does not match x64 Windows")
	}
	hwnd := themeTestWindow(t, false)
	s, err := installBackgroundWindow(hwnd, "LakeNativeTrayTest-"+t.Name(), func() {})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.close)
	if !s.added {
		t.Skip("Explorer notification area unavailable; no-tray fallback covered separately")
	}
	if s.icon.Version != 4 || s.icon.Icon == 0 {
		t.Fatal("native notification icon is incomplete")
	}
	themeUser.NewProc("SendMessageW").Call(hwnd, windowClose, 0, 0)
	themeUser.NewProc("SendMessageW").Call(hwnd, trayCallback, 0, uintptr(s.icon.ID)<<16|0x400)
	visible, _, _ := themeUser.NewProc("IsWindowVisible").Call(hwnd)
	if visible == 0 {
		t.Fatal("native tray activation failed")
	}
}
