//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// development is empty in release builds. Local dev builds inject "1" through
// -ldflags (scripts/build_lake_windows.py --dev), the Windows counterpart of
// the macOS Dev bundle identifier. It labels the build, keeps its data separate
// from release data, and takes it out of the release update channel.
var development = ""

// developmentUpdateMessage matches the macOS Dev client's update text.
const developmentUpdateMessage = "本地测试版：通过本地构建更新，不接收正式版更新"

func isDevelopment() bool { return development != "" }

// windowTitle marks the taskbar and Alt-Tab entries. The visible title bar is the
// workbench header itself.
func windowTitle() string {
	if isDevelopment() {
		return "Lake Dev " + version
	}
	return "Lake " + version
}

// The fixed, version-independent directory survives Dev executable updates.
func lakeHomeDirectory() string {
	if isDevelopment() {
		return ".lake-dev"
	}
	return ".lake"
}

func profileHome(userHome string) (string, error) {
	home := os.Getenv("LAKE_HOME")
	if isDevelopment() {
		home = os.Getenv("LAKE_DEV_HOME")
	}
	if home == "" {
		home = filepath.Join(userHome, lakeHomeDirectory())
	}
	home, err := filepath.Abs(home)
	if err != nil {
		return "", err
	}
	if isDevelopment() {
		release := filepath.Join(userHome, ".lake")
		resolved := func(path string) string {
			if real, err := filepath.EvalSymlinks(path); err == nil {
				return real
			}
			return path
		}
		release, target := strings.ToLower(filepath.Clean(resolved(release))), strings.ToLower(filepath.Clean(resolved(home)))
		if target == release || strings.HasPrefix(target, release+string(filepath.Separator)) {
			return "", fmt.Errorf("Lake Dev 数据目录不能指向正式版 .lake，请使用独立的 LAKE_DEV_HOME")
		}
	}
	return home, nil
}

// developmentBadge marks the development build next to the workbench brand, the
// same way client/macos does, so a Dev window is never mistaken for a release one.
// It runs when the document is created — before the workbench parses its markup —
// so it waits for the document element and head to exist.
const developmentBadge = `(()=>{const mark=()=>{document.documentElement.classList.add('lake-development');const style=document.createElement('style');style.textContent='.lake-development .brand::after { content: "DEV"; font: 600 10px system-ui; padding: 3px 5px; border: 1px solid var(--border); border-radius: 4px; color: var(--text-secondary); }';document.head.appendChild(style);document.title='Lake Dev';};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mark,{once:true});else mark();})();`
