//go:build windows

package main

import (
	"runtime"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func themeTestWindow(t *testing.T, fallback bool) uintptr {
	t.Helper()
	runtime.LockOSThread()
	t.Cleanup(runtime.UnlockOSThread)
	class, _ := windows.UTF16PtrFromString("STATIC")
	title, _ := windows.UTF16PtrFromString("Lake caption test")
	hwnd, _, err := themeUser.NewProc("CreateWindowExW").Call(0,
		uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(title)),
		0xcf0000, 100, 100, 600, 400, 0, 0, 0, 0)
	if hwnd == 0 {
		t.Fatalf("create window: %v", err)
	}
	t.Cleanup(func() {
		themeUser.NewProc("DestroyWindow").Call(hwnd)
		if _, exists := windowThemes[hwnd]; exists {
			t.Error("destroyed HWND retained")
		}
	})
	if err := installWindowTheme(hwnd, fallback); err != nil {
		t.Fatal(err)
	}
	themeUser.NewProc("ShowWindow").Call(hwnd, 4) // SW_SHOWNOACTIVATE.
	themeUser.NewProc("UpdateWindow").Call(hwnd)
	return hwnd
}

func TestWindowsAutomaticCaption(t *testing.T) {
	hwnd := themeTestWindow(t, false)
	state := windowThemes[hwnd]
	if highContrast() {
		if !state.native {
			t.Fatal("high contrast must retain system rendering")
		}
		return
	}
	if windows.RtlGetVersion().BuildNumber < 22000 {
		if state.native {
			t.Fatal("Windows 10 must select compatibility painting")
		}
		return
	}
	if !state.native {
		t.Fatal("Windows 11 must select native caption colors")
	}
	var color uint32
	get := windows.NewLazySystemDLL("dwmapi.dll").NewProc("DwmGetWindowAttribute")
	hr, _, _ := get.Call(hwnd, 35, uintptr(unsafe.Pointer(&color)), 4)
	if int32(hr) < 0 || color != paperColor {
		t.Fatalf("caption color: HRESULT=%x color=%x", hr, color)
	}
}

func TestWindowsCompatibilityCaption(t *testing.T) {
	if highContrast() {
		t.Skip("system high contrast enabled")
	}
	hwnd := themeTestWindow(t, true)
	state := windowThemes[hwnd]
	if state.native {
		t.Fatal("forced Windows 10 path selected native rendering")
	}
	info, window := titleGeometry(hwnd)
	if info.Title.Bottom <= info.Title.Top {
		t.Fatal("missing caption geometry")
	}
	// Native hit tests and system commands must survive custom painting.
	x, y := (info.Title.Left+info.Title.Right)/2, (info.Title.Top+info.Title.Bottom)/2
	position := uintptr(uint32(uint16(x)) | uint32(uint16(y))<<16)
	hit, _, _ := themeUser.NewProc("SendMessageW").Call(hwnd, 0x84, 0, position)
	if hit != 2 {
		t.Fatalf("caption hit test = %d; expected HTCAPTION", hit)
	}
	for index, expected := range map[int]uintptr{2: 8, 3: 9, 5: 20} {
		r := info.Rects[index]
		if r.Right <= r.Left || info.States[index]&0x18000 != 0 {
			t.Fatalf("missing button %d", index)
		}
		pos := uintptr(uint32(uint16((r.Left+r.Right)/2)) | uint32(uint16((r.Top+r.Bottom)/2))<<16)
		actual, _, _ := themeUser.NewProc("SendMessageW").Call(hwnd, 0x84, 0, pos)
		if actual != expected {
			t.Fatalf("button %d: hit %d, expected %d", index, actual, expected)
		}
	}
	// Test actual GDI pixels without needing WebView2.
	for _, active := range []uintptr{0, 1} {
		themeUser.NewProc("SendMessageW").Call(hwnd, 0x86, active, 0)
		state.paint(hwnd)
		dc, _, _ := themeUser.NewProc("GetWindowDC").Call(hwnd)
		color, _, _ := themeGDI.NewProc("GetPixel").Call(dc, uintptr(x-window.Left), uintptr(y-window.Top))
		themeUser.NewProc("ReleaseDC").Call(hwnd, dc)
		if color != paperColor {
			t.Fatalf("active=%d: caption pixel=%x, expected=%x", active, color, paperColor)
		}
	}
	themeUser.NewProc("SendMessageW").Call(hwnd, 0x112, 0xf030, 0) // SC_MAXIMIZE.
	zoomed, _, _ := themeUser.NewProc("IsZoomed").Call(hwnd)
	if zoomed == 0 {
		t.Fatal("native maximize command failed")
	}
	themeUser.NewProc("SendMessageW").Call(hwnd, 0x112, 0xf120, 0) // SC_RESTORE.
	zoomed, _, _ = themeUser.NewProc("IsZoomed").Call(hwnd)
	if zoomed != 0 {
		t.Fatal("native restore command failed")
	}
}
