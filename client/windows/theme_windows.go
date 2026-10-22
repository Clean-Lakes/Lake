//go:build windows

package main

import (
	"fmt"
	"golang.org/x/sys/windows"
	"unsafe"
)

var (
	themeUser           = windows.NewLazySystemDLL("user32.dll")
	themeGDI            = windows.NewLazySystemDLL("gdi32.dll")
	themeDWM            = windows.NewLazySystemDLL("dwmapi.dll").NewProc("DwmSetWindowAttribute")
	themeUX             = windows.NewLazySystemDLL("uxtheme.dll").NewProc("SetWindowTheme")
	themeComctl         = windows.NewLazySystemDLL("comctl32.dll")
	themeSetSubclass    = themeComctl.NewProc("SetWindowSubclass")
	themeRemoveSubclass = themeComctl.NewProc("RemoveWindowSubclass")
	themeDefSubclass    = themeComctl.NewProc("DefSubclassProc")
	themeCallback       uintptr
	// Only accessed on the locked window/message-loop thread.
	windowThemes = map[uintptr]*windowTheme{}
)

func init() {
	themeCallback = windows.NewCallback(windowThemeProc)
}

const (
	paperColor   = 0x00fcfcfc // COLORREF for --background: #fcfcfc.
	inkColor     = 0x00222222 // --foreground: #222222.
	lineColor    = 0x00e5e5e5 // --border: #e5e5e5.
	themeRefresh = 0x8031
	// The one-pixel DWM border line kept between the window edge and the
	// client on top — the same visible gap content keeps at the sides.
	topFrameLine = 1
)

type windowTheme struct {
	native, contrast, forceFallback bool
	hover                           uintptr
}

type titleBarInfo struct {
	Size   uint32
	Title  windows.Rect
	States [6]uint32
	Rects  [6]windows.Rect
}

// NCCALCSIZE_PARAMS: the window rect on entry, the proposed client rect that
// DefSubclassProc overwrites, the restorable rect, and the window's show state.
type nccalcsizeParams struct {
	Rg  [3]windows.Rect
	Pos uintptr
}

func applyWindowColors(handle unsafe.Pointer) error {
	return installWindowTheme(uintptr(handle), false)
}

func installWindowTheme(hwnd uintptr, forceFallback bool) error {
	state := &windowTheme{forceFallback: forceFallback}
	windowThemes[hwnd] = state
	ok, _, err := themeSetSubclass.Call(hwnd, themeCallback, 1, 1)
	if ok == 0 {
		delete(windowThemes, hwnd)
		return fmt.Errorf("无法设置窗口标题栏：%w", err)
	}
	state.configure(hwnd)
	themeSetSubclass.Call(hwnd, themeCallback, 1, 0)
	themeUser.NewProc("RedrawWindow").Call(hwnd, 0, 0, 0x501) // FRAME | UPDATENOW | INVALIDATE.
	return nil
}

func setDWM(hwnd uintptr, attribute, value uint32) bool {
	if themeDWM.Find() != nil {
		return false
	}
	result, _, _ := themeDWM.Call(hwnd, uintptr(attribute), uintptr(unsafe.Pointer(&value)), 4)
	return int32(result) >= 0
}

func highContrast() bool {
	var info struct {
		Size, Flags uint32
		Scheme      *uint16
	}
	info.Size = uint32(unsafe.Sizeof(info))
	ok, _, _ := themeUser.NewProc("SystemParametersInfoW").Call(0x42, uintptr(info.Size), uintptr(unsafe.Pointer(&info)), 0)
	return ok != 0 && info.Flags&1 != 0
}

func (s *windowTheme) configure(hwnd uintptr) {
	s.contrast = highContrast()
	s.hover = 0
	// Restore native theme first, also when accessibility settings change.
	themeUX.Call(hwnd, 0, 0)
	setDWM(hwnd, 2, 2) // DWMWA_NCRENDERING_POLICY: ENABLED.
	if s.contrast {
		for _, attr := range []uint32{34, 35, 36} {
			setDWM(hwnd, attr, 0xffffffff)
		}
		s.native = true
		return
	}
	setDWM(hwnd, 20, 0)
	s.native = !s.forceFallback && setDWM(hwnd, 35, paperColor)
	if s.native {
		setDWM(hwnd, 34, lineColor)
		setDWM(hwnd, 36, inkColor)
		return
	}
	// Windows 10 lacks caption-color attributes. Paint only the native
	// non-client caption. Windows still owns hit testing, resize/drag,
	// double-click maximize, system menu and caption button commands.
	setDWM(hwnd, 2, 1) // DISABLED: classic, paintable non-client frame.
	empty := uint16(0)
	themeUX.Call(hwnd, uintptr(unsafe.Pointer(&empty)), uintptr(unsafe.Pointer(&empty)))
}

func windowThemeProc(hwnd, msg, wp, lp, id, ref uintptr) uintptr {
	s := windowThemes[hwnd]
	if s == nil {
		r, _, _ := themeDefSubclass.Call(hwnd, msg, wp, lp)
		return r
	}
	if msg == 0x82 { // WM_NCDESTROY.
		themeRemoveSubclass.Call(hwnd, themeCallback, id)
		delete(windowThemes, hwnd)
		r, _, _ := themeDefSubclass.Call(hwnd, msg, wp, lp)
		return r
	}
	if msg == 0x83 { // Only stretch after the workbench removes WS_CAPTION.
		style, _, _ := themeUser.NewProc("GetWindowLongPtrW").Call(hwnd, windowStyleIndex)
		if style&windowCaption == 0 {
			return stretchClientOverTopFrame(hwnd, msg, wp, lp)
		}
	}
	r, _, _ := themeDefSubclass.Call(hwnd, msg, wp, lp)
	if msg == 0x24 { // WM_GETMINMAXINFO: a borderless maximized window still excludes the taskbar.
		style, _, _ := themeUser.NewProc("GetWindowLongPtrW").Call(hwnd, windowStyleIndex)
		if style&windowCaption == 0 {
			if monitor, ok := windowMonitor(hwnd); ok {
				info := *(**workbenchMinMaxInfo)(unsafe.Pointer(&lp))
				maximizeInWorkArea(info, monitor.Monitor, monitor.Work)
			}
		}
	}
	switch msg {
	case 0x31a, 0x1a: // WM_THEMECHANGED, WM_SETTINGCHANGE.
		// SetWindowTheme sends WM_THEMECHANGED synchronously. Defer and
		// coalesce refreshes, guarding against recursive theme changes.
		if ref == 0 {
			themeSetSubclass.Call(hwnd, themeCallback, id, 1)
			themeUser.NewProc("PostMessageW").Call(hwnd, themeRefresh, 0, 0)
		}
	case themeRefresh:
		s.configure(hwnd)
		themeSetSubclass.Call(hwnd, themeCallback, id, 0)
		themeUser.NewProc("RedrawWindow").Call(hwnd, 0, 0, 0x401)
	case 0xa0: // WM_NCMOUSEMOVE.
		s.hover = wp
		var track struct {
			Size, Flags uint32
			Window      uintptr
			Time        uint32
		}
		track.Size = uint32(unsafe.Sizeof(track))
		track.Flags = 0x12
		track.Window = hwnd
		themeUser.NewProc("TrackMouseEvent").Call(uintptr(unsafe.Pointer(&track)))
	case 0x2a2: // WM_NCMOUSELEAVE.
		s.hover = 0
	}
	if !s.native {
		switch msg {
		case 0x85, 0x86, 0x6, 0xc, 0x5, 0x47, 0x2e0, 0xa0, 0x2a2, 0xa1, 0xa2, themeRefresh:
			s.paint(hwnd)
		}
	}
	return r
}

// The workbench replaces the caption, and the window keeps its thick resize
// frame after WS_CAPTION is removed. DefWindowProc then insets the top by the
// full frame width, the same as the sides. On the sides that band is the
// invisible resize margin plus the one-pixel window border, so content sits one
// pixel inside the visible frame. Above the window there is no invisible
// margin: the same band lies inside the visible frame, and DWM paints it in
// caption color — the white strip under the top edge. Keep only the border
// line on top so content reaches the top frame exactly as it reaches the sides.
// rgrc[0] holds the proposed window rect on entry and is overwritten with the
// client rect by DefSubclassProc, so the entry copy is taken first. The clamp
// only shrinks the band; it never grows it past the frame line.
func stretchClientOverTopFrame(hwnd, msg, wp, lp uintptr) uintptr {
	zoomed, _, _ := themeUser.NewProc("IsZoomed").Call(hwnd)
	monitor, valid := windowMonitor(hwnd)
	if wp != 0 {
		params := *(**nccalcsizeParams)(unsafe.Pointer(&lp))
		entry := params.Rg[0]
		r, _, _ := themeDefSubclass.Call(hwnd, msg, wp, lp)
		if zoomed != 0 && valid {
			params.Rg[0] = monitor.Work
			return r
		}
		if params.Rg[0].Top-entry.Top > topFrameLine {
			params.Rg[0].Top = entry.Top + topFrameLine
		}
		return r
	}
	rect := *(**windows.Rect)(unsafe.Pointer(&lp))
	entry := *rect
	r, _, _ := themeDefSubclass.Call(hwnd, msg, wp, lp)
	if zoomed != 0 && valid {
		*rect = monitor.Work
		return r
	}
	if rect.Top-entry.Top > topFrameLine {
		rect.Top = entry.Top + topFrameLine
	}
	return r
}

func titleGeometry(hwnd uintptr) (titleBarInfo, windows.Rect) {
	var info titleBarInfo
	info.Size = uint32(unsafe.Sizeof(info))
	themeUser.NewProc("SendMessageW").Call(hwnd, 0x33f, 0, uintptr(unsafe.Pointer(&info)))
	var window windows.Rect
	themeUser.NewProc("GetWindowRect").Call(hwnd, uintptr(unsafe.Pointer(&window)))
	return info, window
}

func fillCaptionRect(dc uintptr, rect windows.Rect, color uint32) {
	brush, _, _ := themeGDI.NewProc("CreateSolidBrush").Call(uintptr(color))
	if brush == 0 {
		return
	}
	themeUser.NewProc("FillRect").Call(dc, uintptr(unsafe.Pointer(&rect)), brush)
	themeGDI.NewProc("DeleteObject").Call(brush)
}

func (s *windowTheme) paint(hwnd uintptr) {
	info, window := titleGeometry(hwnd)
	if info.Title.Bottom <= info.Title.Top {
		return
	}
	dc, _, _ := themeUser.NewProc("GetWindowDC").Call(hwnd)
	if dc == 0 {
		return
	}
	defer themeUser.NewProc("ReleaseDC").Call(hwnd, dc)
	local := func(rect windows.Rect) windows.Rect {
		rect.Left -= window.Left
		rect.Right -= window.Left
		rect.Top -= window.Top
		rect.Bottom -= window.Top
		return rect
	}
	caption := local(info.Title)
	// TITLEBARINFOEX excludes the window-menu icon; include that area.
	caption.Left = window.Right - window.Left - caption.Right
	fillCaptionRect(dc, caption, paperColor)
	dpi, _, _ := themeUser.NewProc("GetDpiForWindow").Call(hwnd)
	if dpi == 0 {
		dpi = 96
	}
	scale := func(value int32) int32 { return value * int32(dpi) / 96 }
	iconSize := scale(16)
	icon, _, _ := themeUser.NewProc("SendMessageW").Call(hwnd, 0x7f, 2, 0) // ICON_SMALL2.
	if icon == 0 {
		icon, _, _ = themeUser.NewProc("GetClassLongPtrW").Call(hwnd, ^uintptr(33))
	} // GCLP_HICONSM = -34.
	x := caption.Left + scale(5)
	y := caption.Top + (caption.Bottom-caption.Top-iconSize)/2
	if icon != 0 {
		themeUser.NewProc("DrawIconEx").Call(dc, uintptr(x), uintptr(y), icon, uintptr(iconSize), uintptr(iconSize), 0, 0, 3)
	}
	textRect := caption
	textRect.Left = x + iconSize + scale(6)
	for _, index := range []int{2, 3, 5} {
		if info.States[index]&0x18000 == 0 && info.Rects[index].Right > info.Rects[index].Left {
			rect := local(info.Rects[index])
			if rect.Left < textRect.Right {
				textRect.Right = rect.Left - scale(4)
			}
		}
	}
	var title [512]uint16
	themeUser.NewProc("GetWindowTextW").Call(hwnd, uintptr(unsafe.Pointer(&title[0])), uintptr(len(title)))
	face, _ := windows.UTF16PtrFromString("Segoe UI")
	font, _, _ := themeGDI.NewProc("CreateFontW").Call(uintptr(-int64(scale(12))), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(face)))
	if font != 0 {
		old, _, _ := themeGDI.NewProc("SelectObject").Call(dc, font)
		defer themeGDI.NewProc("DeleteObject").Call(font)
		defer themeGDI.NewProc("SelectObject").Call(dc, old)
	}
	themeGDI.NewProc("SetBkMode").Call(dc, 1)
	themeGDI.NewProc("SetTextColor").Call(dc, inkColor)
	themeUser.NewProc("DrawTextW").Call(dc, uintptr(unsafe.Pointer(&title[0])), ^uintptr(0), uintptr(unsafe.Pointer(&textRect)), 0x8824) // single line, vcenter, ellipsis, no prefix.
	for _, index := range []int{2, 3, 5} {
		if info.States[index]&0x18000 != 0 || info.Rects[index].Right <= info.Rects[index].Left {
			continue
		}
		rect := local(info.Rects[index])
		color := uint32(inkColor)
		hit := map[int]uintptr{2: 8, 3: 9, 5: 20}[index]
		background := uint32(paperColor)
		if s.hover == hit {
			background = 0x00eeeeee
			if index == 5 {
				background = 0x002323c4
				color = 0x00ffffff
			}
			fillCaptionRect(dc, rect, background)
		}
		pen, _, _ := themeGDI.NewProc("CreatePen").Call(0, uintptr(scale(1)), uintptr(color))
		old, _, _ := themeGDI.NewProc("SelectObject").Call(dc, pen)
		cx, cy := (rect.Left+rect.Right)/2, (rect.Top+rect.Bottom)/2
		half := scale(4)
		line := func(x1, y1, x2, y2 int32) {
			themeGDI.NewProc("MoveToEx").Call(dc, uintptr(x1), uintptr(y1), 0)
			themeGDI.NewProc("LineTo").Call(dc, uintptr(x2), uintptr(y2))
		}
		box := func(x, y int32) {
			line(x-half, y-half, x+half, y-half)
			line(x+half, y-half, x+half, y+half)
			line(x+half, y+half, x-half, y+half)
			line(x-half, y+half, x-half, y-half)
		}
		switch index {
		case 2:
			line(cx-half, cy, cx+half, cy)
		case 3:
			zoomed, _, _ := themeUser.NewProc("IsZoomed").Call(hwnd)
			if zoomed != 0 {
				box(cx+scale(2), cy-scale(2))
				fillCaptionRect(dc, windows.Rect{Left: cx - half, Top: cy - half, Right: cx + half, Bottom: cy + half}, background)
			}
			box(cx, cy)
		case 5:
			line(cx-half, cy-half, cx+half, cy+half)
			line(cx-half, cy+half, cx+half, cy-half)
		}
		themeGDI.NewProc("SelectObject").Call(dc, old)
		themeGDI.NewProc("DeleteObject").Call(pen)
	}
}
