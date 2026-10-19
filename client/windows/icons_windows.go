//go:build windows

package main

import (
	_ "embed"
	"encoding/binary"
	"fmt"
	"runtime"
	"unsafe"
)

// The same multi-resolution artwork is embedded in the executable's resources
// by the packager. Keeping it here also brands locally built windows and trays.
//
//go:embed icon.ico
var applicationIcon []byte

type applicationIcons struct{ small, large uintptr }

func applicationIconImage(size int) ([]byte, error) {
	data := applicationIcon
	if len(data) < 6 || binary.LittleEndian.Uint16(data[:2]) != 0 || binary.LittleEndian.Uint16(data[2:4]) != 1 {
		return nil, fmt.Errorf("Lake 图标格式无效")
	}
	count := int(binary.LittleEndian.Uint16(data[4:6]))
	if count == 0 || 6+count*16 > len(data) {
		return nil, fmt.Errorf("Lake 图标目录无效")
	}
	var best []byte
	bestSize := 0
	for i := 0; i < count; i++ {
		entry := data[6+i*16 : 6+(i+1)*16]
		width := int(entry[0])
		if width == 0 {
			width = 256
		}
		length := uint64(binary.LittleEndian.Uint32(entry[8:12]))
		offset := uint64(binary.LittleEndian.Uint32(entry[12:16]))
		if length == 0 || offset < uint64(6+count*16) || offset+length > uint64(len(data)) {
			return nil, fmt.Errorf("Lake 图标图像无效")
		}
		// Prefer an exact match, then downsample the nearest larger image.
		if best == nil || (width >= size && (bestSize < size || width < bestSize)) || (width < size && bestSize < size && width > bestSize) {
			best, bestSize = data[offset:offset+length], width
		}
	}
	return best, nil
}

func loadApplicationIcon(size int) (uintptr, error) {
	data, err := applicationIconImage(size)
	if err != nil {
		return 0, err
	}
	// CreateIconFromResourceEx accepts PNG icon resources on supported Windows.
	icon, _, callErr := themeUser.NewProc("CreateIconFromResourceEx").Call(
		uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)), 1, 0x30000,
		uintptr(size), uintptr(size), 0)
	runtime.KeepAlive(data)
	if icon == 0 {
		return 0, fmt.Errorf("无法加载 Lake 图标：%w", callErr)
	}
	return icon, nil
}

func windowIconSize(hwnd, metric uintptr, fallback int) int {
	dpi, _, _ := themeUser.NewProc("GetDpiForWindow").Call(hwnd)
	if dpi == 0 {
		dpi = 96
	}
	size, _, _ := themeUser.NewProc("GetSystemMetricsForDpi").Call(metric, dpi)
	if size == 0 {
		return fallback
	}
	return int(size)
}

func installApplicationIcons(hwnd uintptr) (*applicationIcons, error) {
	icons := &applicationIcons{}
	var err error
	icons.small, err = loadApplicationIcon(windowIconSize(hwnd, 49, 16)) // SM_CXSMICON.
	if err != nil {
		return nil, err
	}
	icons.large, err = loadApplicationIcon(windowIconSize(hwnd, 11, 32)) // SM_CXICON.
	if err != nil {
		icons.close()
		return nil, err
	}
	themeUser.NewProc("SendMessageW").Call(hwnd, 0x80, 0, icons.small) // WM_SETICON, ICON_SMALL.
	themeUser.NewProc("SendMessageW").Call(hwnd, 0x80, 1, icons.large) // WM_SETICON, ICON_BIG.
	return icons, nil
}

func (icons *applicationIcons) close() {
	for _, icon := range []uintptr{icons.small, icons.large} {
		if icon != 0 {
			themeUser.NewProc("DestroyIcon").Call(icon)
		}
	}
	icons.small, icons.large = 0, 0
}
