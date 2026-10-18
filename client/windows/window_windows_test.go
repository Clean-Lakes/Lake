//go:build windows

package main

import (
	"golang.org/x/sys/windows"
	"testing"
)

func TestScaleWindowSize(t *testing.T) {
	cases := []struct {
		dpi, width, height int
	}{
		{96, 1280, 840},   // 100%: the window keeps the macOS frame
		{120, 1600, 1050}, // 125%
		{144, 1920, 1260}, // 150%
		{216, 2880, 1890}, // 225%
		{0, 1280, 840},    // a failed GetDpiForSystem call keeps logical pixels
	}
	for _, c := range cases {
		width, height := scaleWindowSize(windowOpenWidth, windowOpenHeight, c.dpi)
		if width != c.width || height != c.height {
			t.Errorf("scaleWindowSize(dpi %d) = %dx%d, want %dx%d", c.dpi, width, height, c.width, c.height)
		}
	}
}

func TestScaledSizeFloor(t *testing.T) {
	width, height := scaleWindowSize(windowMinimumWidth, windowMinimumHeight, 216)
	if width != 1913 || height != 1350 {
		t.Errorf("minimum at 225%% = %dx%d, want 1913x1350", width, height)
	}
}

func TestFitWorkArea(t *testing.T) {
	cases := []struct {
		name                       string
		workWidth, workHeight, dpi int
		width, height              int
	}{
		{"scaled frame fits the desktop", 3840, 2160, 144, 1920, 1260},
		{"unscaled frame fits the desktop", 1920, 1080, 96, 1280, 840},
		{"desktop smaller than the scaled frame", 2880, 1692, 216, 2880, 1692},
		{"work area below the size floor", 800, 600, 96, 800, 600},
		{"failed measurement keeps the frame", 0, 0, 216, 2880, 1890},
	}
	for _, c := range cases {
		width, height := fitWorkArea(c.workWidth, c.workHeight, c.dpi)
		if width != c.width || height != c.height {
			t.Errorf("%s: fitWorkArea(%d, %d, %d) = %dx%d, want %dx%d", c.name, c.workWidth, c.workHeight, c.dpi, width, height, c.width, c.height)
		}
	}
}

func TestMaximizeUsesWorkAreaOnEveryTaskbarEdge(t *testing.T) {
	monitor := windows.Rect{Left: -1920, Top: 0, Right: 0, Bottom: 1080}
	for name, work := range map[string]windows.Rect{
		"bottom": {Left: -1920, Top: 0, Right: 0, Bottom: 1032},
		"top":    {Left: -1920, Top: 48, Right: 0, Bottom: 1080},
		"left":   {Left: -1872, Top: 0, Right: 0, Bottom: 1080},
		"right":  {Left: -1920, Top: 0, Right: -48, Bottom: 1080},
	} {
		t.Run(name, func(t *testing.T) {
			info := workbenchMinMaxInfo{MinTrackSize: windowPoint{X: 850, Y: 600}}
			maximizeInWorkArea(&info, monitor, work)
			left, top := monitor.Left+info.MaxPosition.X, monitor.Top+info.MaxPosition.Y
			if (windows.Rect{Left: left, Top: top, Right: left + info.MaxSize.X, Bottom: top + info.MaxSize.Y}) != work {
				t.Fatalf("maximized bounds escaped work area: %+v", info)
			}
			if info.MinTrackSize != (windowPoint{X: 850, Y: 600}) {
				t.Fatal("minimum tracking size changed")
			}
		})
	}
}
