//go:build windows

package main

import (
	"bytes"
	"image/png"
	"testing"
)

func TestWindowsApplicationIconSizes(t *testing.T) {
	for _, size := range []int{16, 20, 24, 32, 40, 48, 64, 128, 256} {
		data, err := applicationIconImage(size)
		if err != nil {
			t.Fatal(err)
		}
		config, err := png.DecodeConfig(bytes.NewReader(data))
		if err != nil || config.Width != size || config.Height != size {
			t.Fatalf("icon at %dpx: config=%+v error=%v", size, config, err)
		}
		icon, err := loadApplicationIcon(size)
		if err != nil {
			t.Fatalf("native icon at %dpx: %v", size, err)
		}
		themeUser.NewProc("DestroyIcon").Call(icon)
	}
	// A nonstandard DPI uses a larger source rather than enlarging 24px pixels.
	data, err := applicationIconImage(28)
	if err != nil {
		t.Fatal(err)
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width != 32 {
		t.Fatalf("28px icon must use 32px source: config=%+v error=%v", config, err)
	}
}

func TestWindowsTrayUsesExplicitLakeIconWithoutExecutableResources(t *testing.T) {
	hwnd := themeTestWindow(t, false)
	icons, err := installApplicationIcons(hwnd)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// Detach the owned handles before the fixture later destroys the HWND.
		themeUser.NewProc("SendMessageW").Call(hwnd, 0x80, 0, 0)
		themeUser.NewProc("SendMessageW").Call(hwnd, 0x80, 1, 0)
		icons.close()
	})
	for kind, expected := range map[uintptr]uintptr{0: icons.small, 1: icons.large} {
		actual, _, _ := themeUser.NewProc("SendMessageW").Call(hwnd, 0x7f, kind, 0)
		if actual != expected {
			t.Fatalf("window icon %d is not the Lake artwork", kind)
		}
	}
	s, err := installBackgroundWithNotify(hwnd, "LakeBrandIconTest", func() {}, func(_ uint32, icon *trayIconData) bool {
		if icon.Icon != icons.small {
			t.Error("tray substituted a generic or large icon")
		}
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.close)
	themeUser.NewProc("SendMessageW").Call(hwnd, backgroundTaskbar, 0, 0)
	if !s.added || s.icon.Icon != icons.small {
		t.Fatal("Explorer restart lost the Lake tray icon")
	}
}
