//go:build windows

package main

// development is empty in release builds. Local dev builds inject "1" through
// -ldflags (see dist/windows/dev/build_dev_client.py), the Windows counterpart of
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

// lakeHomeDirectory separates the development client from release data. LAKE_HOME
// still overrides it, and the single-instance mutex is keyed by home, so a Dev
// client and a release client run side by side.
func lakeHomeDirectory() string {
	if isDevelopment() {
		return ".lake-dev"
	}
	return ".lake"
}

// developmentBadge marks the development build next to the workbench brand, the
// same way client/macos does, so a Dev window is never mistaken for a release one.
// It runs when the document is created — before the workbench parses its markup —
// so it waits for the document element and head to exist.
const developmentBadge = `(()=>{const mark=()=>{document.documentElement.classList.add('lake-development');const style=document.createElement('style');style.textContent='.lake-development .brand::after { content: "DEV"; font: 600 10px system-ui; padding: 3px 5px; border: 1px solid var(--border); border-radius: 4px; color: var(--text-secondary); }';document.head.appendChild(style);document.title='Lake Dev';};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mark,{once:true});else mark();})();`
