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
	// STATIC is a control class: its hit test returns HTTRANSPARENT. Use the
	// normal top-level DefWindowProc just like the actual app window.
	class, _ := windows.UTF16PtrFromString("LakeCaptionTest-" + t.Name())
	instance, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW").Call(0)
	windowClass := struct {
		Size, Style                        uint32
		Proc                               uintptr
		ClassExtra, WindowExtra            int32
		Instance, Icon, Cursor, Background uintptr
		Menu, Name                         *uint16
		SmallIcon                          uintptr
	}{Proc: themeUser.NewProc("DefWindowProcW").Addr(), Instance: instance, Name: class}
	windowClass.Size = uint32(unsafe.Sizeof(windowClass))
	if atom, _, err := themeUser.NewProc("RegisterClassExW").Call(uintptr(unsafe.Pointer(&windowClass))); atom == 0 {
		t.Fatalf("register class: %v", err)
	}
	t.Cleanup(func() { themeUser.NewProc("UnregisterClassW").Call(uintptr(unsafe.Pointer(class)), instance) })
	title, _ := windows.UTF16PtrFromString("Lake caption test")
	hwnd, _, err := themeUser.NewProc("CreateWindowExW").Call(0,
		uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(title)),
		0xcf0000, 100, 100, 600, 400, 0, 0, instance, 0)
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
	// DWMWA_CAPTION_COLOR is documented for DwmSetWindowAttribute only;
	// DwmGetWindowAttribute can return E_INVALIDARG for a successful setting.
	if !setDWM(hwnd, 35, paperColor) {
		t.Fatal("native caption color could not be applied")
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

// With the caption removed the client must reach the top frame like it reaches
// the sides: only the one-pixel border line stays above it, while the sides
// keep their invisible resize margin.
func TestWindowsWorkbenchReachesTopFrame(t *testing.T) {
	hwnd := themeTestWindow(t, false)
	if err := extendWorkbenchIntoTitleBar(hwnd); err != nil {
		t.Fatal(err)
	}
	var window windows.Rect
	themeUser.NewProc("GetWindowRect").Call(hwnd, uintptr(unsafe.Pointer(&window)))
	// NCCALCSIZE_PARAMS with a typed WINDOWPOS pointer keeps vet happy while
	// matching the native layout (three RECTs plus a WINDOWPOS pointer).
	var pos struct {
		Hwnd, After  uintptr
		X, Y, Cx, Cy int32
		Flags        uint32
	}
	pos.Hwnd = hwnd
	pos.Cx, pos.Cy = window.Right-window.Left, window.Bottom-window.Top
	params := struct {
		Rg  [3]windows.Rect
		Pos unsafe.Pointer
	}{Rg: [3]windows.Rect{window}, Pos: unsafe.Pointer(&pos)}
	themeUser.NewProc("SendMessageW").Call(hwnd, 0x83, 1, uintptr(unsafe.Pointer(&params)))
	assertTopFrame(t, "NCCALCSIZE valid", window, params.Rg[0])

	rect := window
	themeUser.NewProc("SendMessageW").Call(hwnd, 0x83, 0, uintptr(unsafe.Pointer(&rect)))
	assertTopFrame(t, "NCCALCSIZE rect", window, rect)
}

func assertTopFrame(t *testing.T, name string, entry, client windows.Rect) {
	t.Helper()
	top := client.Top - entry.Top
	if top != topFrameLine {
		t.Fatalf("%s: top band %d, expected the %d-pixel frame line", name, top, topFrameLine)
	}
	if side := client.Left - entry.Left; side <= top {
		t.Fatalf("%s: side inset %d must keep the resize frame", name, side)
	}
	if client.Bottom >= entry.Bottom {
		t.Fatalf("%s: bottom frame removed", name)
	}
}

func TestWindowsWorkbenchMaximizePreservesTaskbarAndRestores(t *testing.T) {
	hwnd := themeTestWindow(t, false)
	if err := extendWorkbenchIntoTitleBar(hwnd); err != nil {
		t.Fatal(err)
	}
	monitor, ok := windowMonitor(hwnd)
	if !ok {
		t.Fatal("monitor work area unavailable")
	}
	themeUser.NewProc("SendMessageW").Call(hwnd, windowCommand, scMaximize, 0)
	zoomed, _, _ := themeUser.NewProc("IsZoomed").Call(hwnd)
	if zoomed == 0 {
		t.Fatal("window did not enter the native maximized state")
	}
	var client windows.Rect
	themeUser.NewProc("GetClientRect").Call(hwnd, uintptr(unsafe.Pointer(&client)))
	origin := windowPoint{}
	themeUser.NewProc("ClientToScreen").Call(hwnd, uintptr(unsafe.Pointer(&origin)))
	actual := windows.Rect{Left: origin.X, Top: origin.Y, Right: origin.X + client.Right, Bottom: origin.Y + client.Bottom}
	if actual != monitor.Work {
		t.Fatalf("maximized client = %+v, want work area %+v", actual, monitor.Work)
	}
	themeUser.NewProc("SendMessageW").Call(hwnd, windowCommand, scRestore, 0)
	zoomed, _, _ = themeUser.NewProc("IsZoomed").Call(hwnd)
	if zoomed != 0 {
		t.Fatal("restore left the window maximized")
	}
}
