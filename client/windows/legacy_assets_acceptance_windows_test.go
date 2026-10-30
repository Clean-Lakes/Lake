//go:build windows

package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	webassets "github.com/Clean-Lakes/Lake/assets/web"
	lakeweb "github.com/Clean-Lakes/Lake/internal/web"
	webview "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
)

// This runs the actual embedded React application and Go API in WebView2,
// using an empty private Home and no model/production credentials.
func TestWindowsLegacyAssetsRetiredInRealWebView(t *testing.T) {
	if _, err := webviewloader.GetInstalledVersion(); err != nil {
		if os.Getenv("LAKE_COMPAT_REQUIRED_WINDOWS_UI") == "1" {
			t.Fatal("Legacy asset exit verification requires the actual WebView2 runtime")
		}
		t.Skip("WebView2 runtime is not installed")
	}
	if os.Getenv("LAKE_COMPAT_WINDOWS_UI_CHILD") != "1" {
		// WebView2 can retain profile file handles until the embedding process
		// exits. Let the parent own cleanup after that actual process boundary.
		home := t.TempDir()
		t.Cleanup(func() {
			deadline := time.Now().Add(10 * time.Second)
			for {
				err := os.RemoveAll(home)
				if err == nil {
					return
				}
				if time.Now().After(deadline) {
					t.Errorf("WebView2 test profile remained locked after process exit: %v", err)
					return
				}
				time.Sleep(100 * time.Millisecond)
			}
		})
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWindowsLegacyAssetsRetiredInRealWebView$", "-test.v")
		command.Env = append(os.Environ(), "LAKE_COMPAT_WINDOWS_UI_CHILD=1", "LAKE_COMPAT_WINDOWS_UI_HOME="+home)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("actual WebView2 acceptance subprocess failed: %v\n%s", err, output)
		}
		return
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	home := os.Getenv("LAKE_COMPAT_WINDOWS_UI_HOME")
	if home == "" {
		t.Fatal("parent-owned isolated Home required")
	}
	server, err := lakeweb.New(context.Background(), lakeweb.Options{Home: home, DynamicPort: true, Token: "p8-synthetic-local-test", Static: webassets.Files(), Output: io.Discard})
	if err != nil {
		t.Fatal("isolated backend setup failed")
	}
	defer server.Close()
	if server.Models.Active() != nil {
		t.Fatal("isolated Home unexpectedly configured a model")
	}
	server.Store.CreateProject("P8 Windows isolated acceptance")
	go func() { _ = server.Start() }()
	var origin string
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		raw, readErr := os.ReadFile(filepath.Join(home, "web-agent", "runtime.json"))
		var info struct {
			Origin string `json:"origin"`
		}
		if readErr == nil && json.Unmarshal(raw, &info) == nil && info.Origin != "" {
			origin = info.Origin
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if origin == "" {
		t.Fatal("isolated backend readiness timed out")
	}
	window := webview.NewWithOptions(webview.WebViewOptions{DataPath: filepath.Join(home, "webview"), WindowOptions: webview.WindowOptions{Title: "Lake retired assets Windows acceptance", Width: 1280, Height: 800}})
	if window == nil {
		t.Fatal("WebView2 window creation failed")
	}
	defer window.Destroy()
	result := make(chan map[string]any, 1)
	if err = window.Bind("__legacyResult", func(raw string) {
		var value map[string]any
		if json.Unmarshal([]byte(raw), &value) != nil {
			value = map[string]any{"passed": false, "error": "invalid UI result"}
		}
		select {
		case result <- value:
		default:
		}
		window.Dispatch(window.Destroy)
	}); err != nil {
		t.Fatal("UI callback setup failed")
	}
	if err = window.Bind("__legacyResize", func() {
		window.Dispatch(func() {
			themeUser.NewProc("SetWindowPos").Call(uintptr(window.Window()), 0, 0, 0, 850, 600, 0x0002|0x0004)
		})
	}); err != nil {
		t.Fatal("native resize binding unavailable")
	}
	window.Init(`document.addEventListener('DOMContentLoaded',()=>{(async()=>{
 let phase='initial_document';
 const wait=async f=>{const until=Date.now()+30000;while(Date.now()<until){const value=f();if(value)return value;await new Promise(r=>setTimeout(r,30));}throw Error('ui_readiness_timeout:'+phase+':'+document.readyState+':'+document.body.innerText.slice(0,180));};
 // A first-run settings button includes a separate "待配置" badge. Match its
 // visible label, while retaining exact matching for ordinary text buttons.
 const button=(root,text)=>Array.from(root.querySelectorAll('button')).find(b=>b.textContent.trim()===text || b.getAttribute('aria-label')===text || Array.from(b.querySelectorAll(':scope > span')).some(label=>label.textContent.trim()===text));
 const panel=()=>document.querySelector('#memory-settings-panel');
 const choose=async(root,text)=>{phase='button:'+text;(await wait(()=>button(root,text))).click();await new Promise(requestAnimationFrame);};
 const assert=(value,code)=>{if(!value)throw Error(code);};
 const absent=()=>{assert(!document.querySelector('#strategy-settings-panel'),'legacy_panel_present');assert(!panel().textContent.includes('历史资产与兼容管理'),'legacy_entry_present');assert(!panel().textContent.includes('旧偏好承接'),'legacy_carry_present');};
 await choose(document,'工作区');await choose(document,'设置');
 (await wait(()=>document.querySelector('#memory-settings-tab'))).click();await wait(panel);absent();
 assert((await fetch('/api/strategy/settings')).status===410,'legacy_settings_available');
 assert((await fetch('/api/natural-memory/legacy')).status===410,'legacy_carry_available');
 assert((await fetch('/api/natural-memory/settings')).status===200,'natural_settings_unavailable');
 document.querySelector('#appearance-settings-tab').click();
 const dark=await wait(()=>Array.from(document.querySelectorAll('[role="radio"]')).find(b=>b.textContent.trim()==='深色'));
 dark.click();await wait(()=>dark.getAttribute('aria-checked')==='true');
 document.querySelector('#memory-settings-tab').click();await wait(panel);absent();
 await window.__legacyResize();phase='native_narrow_resize';await wait(()=>innerWidth<=900);
 assert(panel().scrollWidth<=panel().clientWidth+2,'memory_panel_overflow');
 await window.__legacyResult(JSON.stringify({passed:true,actualBackend:true,actualWebView2:true,defaultNoModel:true,legacyAbsent:true,legacyAPI410:true,naturalSettingsAvailable:true,dark:true,viewportWidth:innerWidth,viewportHeight:innerHeight}));
 })().catch(error=>window.__legacyResult(JSON.stringify({passed:false,error:String(error.message)})));});`)
	timer := time.AfterFunc(50*time.Second, func() { window.Dispatch(window.Destroy) })
	defer timer.Stop()
	window.Navigate(origin + "/#token=p8-synthetic-local-test")
	window.Run()
	select {
	case value := <-result:
		value["platform"] = runtime.GOOS + "/" + runtime.GOARCH
		if path := os.Getenv("LAKE_COMPAT_WINDOWS_REPORT"); path != "" {
			raw, _ := json.MarshalIndent(value, "", "  ")
			if os.WriteFile(path, append(raw, '\n'), 0600) != nil {
				t.Fatal("cannot save UI evidence")
			}
		}
		if value["passed"] != true {
			t.Fatalf("Windows strategy UI failed: %v", value["error"])
		}
	default:
		t.Fatal("Windows legacy asset UI did not report completion")
	}
}
