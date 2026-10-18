//go:build windows

package main

import (
	"math"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The workbench frame matches the macOS client: 1280x840 on open with 850x600 as
// the minimum. Windows measures windows in physical pixels, so those logical values
// have to be scaled by the display DPI — on a 225% display the unscaled numbers
// would open a window less than half the intended size — and clamped to the work
// area, which on a 1280x800 desktop is smaller than the scaled default.
//
// The clamp keeps the macOS rule: shrink only as far as the visible frame demands.
// A narrower opening size is not equivalent — the workbench composes its layout from
// the available width, and taking more of it than necessary wraps the composer's
// model row on a display the macOS client fits.
const (
	windowOpenWidth     = 1280
	windowOpenHeight    = 840
	windowMinimumWidth  = 850
	windowMinimumHeight = 600
	// The work area already excludes the taskbar; no extra margin is taken.
	windowWorkAreaShare = 1.0
	windowBaseDPI       = 96
)

// workbenchGeometry returns the opening size and the size floor in physical pixels
// for the primary monitor, paired with the screen the workbench opens on.
func workbenchGeometry() (width, height, minimumWidth, minimumHeight int) {
	work := primaryWorkArea()
	dpi := systemDPI()
	width, height = fitWorkArea(int(work.Right-work.Left), int(work.Bottom-work.Top), dpi)
	minimumWidth, minimumHeight = scaleWindowSize(windowMinimumWidth, windowMinimumHeight, dpi)
	return
}

// fitWorkArea scales the opening size for the display DPI and keeps it inside the
// work area, so the frame never covers the taskbar.
func fitWorkArea(workWidth, workHeight, dpi int) (int, int) {
	width, height := scaleWindowSize(windowOpenWidth, windowOpenHeight, dpi)
	minimumWidth, minimumHeight := scaleWindowSize(windowMinimumWidth, windowMinimumHeight, dpi)
	return fitWindow(width, minimumWidth, int(float64(workWidth)*windowWorkAreaShare)),
		fitWindow(height, minimumHeight, int(float64(workHeight)*windowWorkAreaShare))
}

// fitWindow bounds a desired size by the size floor and the work area. A work area
// smaller than the floor wins: an oversized window cannot fit on the display. A
// failed measurement reports no limit and leaves the scaled default untouched.
func fitWindow(desired, minimum, limit int) int {
	switch {
	case limit <= 0:
		return desired
	case limit < minimum:
		return limit
	case desired < minimum:
		return minimum
	case desired > limit:
		return limit
	default:
		return desired
	}
}

// scaleWindowSize converts a logical (96 DPI) size to physical pixels.
func scaleWindowSize(width, height, dpi int) (int, int) {
	if dpi < windowBaseDPI {
		// Includes a failed GetDpiForSystem call on Windows 10 builds before 1607.
		dpi = windowBaseDPI
	}
	scale := float64(dpi) / windowBaseDPI
	return int(math.Round(float64(width) * scale)), int(math.Round(float64(height) * scale))
}

// primaryWorkArea returns the primary monitor's work area in physical pixels, or an
// empty rect when the measurement fails.
func primaryWorkArea() windows.Rect {
	var work windows.Rect
	ok, _, _ := themeUser.NewProc("SystemParametersInfoW").Call(0x0030, 0, uintptr(unsafe.Pointer(&work)), 0) // SPI_GETWORKAREA.
	if ok == 0 || work.Right <= work.Left || work.Bottom <= work.Top {
		return windows.Rect{}
	}
	return work
}

func systemDPI() int {
	dpi, _, _ := themeUser.NewProc("GetDpiForSystem").Call()
	return int(dpi)
}

type workbenchMonitorInfo struct {
	Size          uint32
	Monitor, Work windows.Rect
	Flags         uint32
}

type windowPoint struct{ X, Y int32 }

type workbenchMinMaxInfo struct {
	Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize windowPoint
}

func windowMonitor(hwnd uintptr) (workbenchMonitorInfo, bool) {
	var info workbenchMonitorInfo
	info.Size = uint32(unsafe.Sizeof(info))
	monitor, _, _ := themeUser.NewProc("MonitorFromWindow").Call(hwnd, 2) // nearest monitor
	ok, _, _ := themeUser.NewProc("GetMonitorInfoW").Call(monitor, uintptr(unsafe.Pointer(&info)))
	return info, ok != 0 && info.Work.Right > info.Work.Left && info.Work.Bottom > info.Work.Top
}

func maximizeInWorkArea(info *workbenchMinMaxInfo, monitor, work windows.Rect) {
	info.MaxPosition = windowPoint{X: work.Left - monitor.Left, Y: work.Top - monitor.Top}
	info.MaxSize = windowPoint{X: work.Right - work.Left, Y: work.Bottom - work.Top}
}
