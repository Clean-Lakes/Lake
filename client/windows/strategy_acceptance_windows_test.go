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
func TestWindowsStrategyConfirmationInRealWebView(t *testing.T) {
	if _, err := webviewloader.GetInstalledVersion(); err != nil {
		if os.Getenv("LAKE_P8_REQUIRED_WINDOWS_UI") == "1" {
			t.Fatal("P8 requires the actual WebView2 runtime")
		}
		t.Skip("WebView2 runtime is not installed")
	}
	if os.Getenv("LAKE_P8_WINDOWS_UI_CHILD") != "1" {
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
		command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWindowsStrategyConfirmationInRealWebView$", "-test.v")
		command.Env = append(os.Environ(), "LAKE_P8_WINDOWS_UI_CHILD=1", "LAKE_P8_WINDOWS_UI_HOME="+home)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("actual WebView2 acceptance subprocess failed: %v\n%s", err, output)
		}
		return
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	home := os.Getenv("LAKE_P8_WINDOWS_UI_HOME")
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
	window := webview.NewWithOptions(webview.WebViewOptions{DataPath: filepath.Join(home, "webview"), WindowOptions: webview.WindowOptions{Title: "Lake P8 Windows acceptance", Width: 1280, Height: 800}})
	if window == nil {
		t.Fatal("WebView2 window creation failed")
	}
	defer window.Destroy()
	result := make(chan map[string]any, 1)
	if err = window.Bind("__p8Result", func(raw string) {
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
	if err = window.Bind("__p8Resize", func() {
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
 const panel=()=>document.querySelector('#strategy-settings-panel');
 const confirmation=()=>panel()?.querySelector('[aria-label="确认策略操作"]');
 const choose=async(root,text)=>{phase='button:'+text;(await wait(()=>{const current=typeof root==='function'?root():root;return current?.isConnected&&button(current,text);})).click();await new Promise(requestAnimationFrame);};
 const assert=(value,code)=>{if(!value)throw Error(code);};
 await choose(document,'工作区'); await choose(document,'设置');
 (await wait(()=>document.querySelector('#strategy-settings-tab'))).click();
 phase='strategy_panel';
 await wait(panel);
 await choose(panel,'新建');
 phase='title_field';
 const title=await wait(()=>panel().querySelector('input[maxlength="240"]'));
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(title,'P8 unsaved Windows draft');
 title.dispatchEvent(new Event('input',{bubbles:true}));
 await choose(panel,'新建');
 phase='unsaved_confirmation';
 await wait(confirmation);
 let buttons=confirmation().querySelectorAll('button');
 assert(document.activeElement===buttons[0],'initial_cancel_focus');
 buttons[0].dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
 assert(document.activeElement===buttons[1],'tab_escaped_confirmation');
 buttons[1].dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));
 assert(document.activeElement===buttons[0],'shift_tab_escaped_confirmation');
 buttons[0].dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 await wait(()=>!confirmation());
 assert(panel().querySelector('input[maxlength="240"]').value==='P8 unsaved Windows draft','escape_lost_draft');
 assert(document.querySelector('#strategy-settings-panel'),'escape_closed_settings');
 await choose(panel,'新建'); await wait(confirmation);
 await choose(confirmation,'确认操作');
 await wait(()=>!confirmation());
 assert(panel().querySelector('input[maxlength="240"]').value==='','confirmed_discard_failed');
 document.querySelector('#appearance-settings-tab').click();
 const dark=await wait(()=>Array.from(document.querySelectorAll('[role="radio"]')).find(b=>b.textContent.trim()==='深色'));
 dark.click(); await wait(()=>dark.getAttribute('aria-checked')==='true');
 document.querySelector('#strategy-settings-tab').click();
 await wait(panel);
 await window.__p8Resize(); phase='native_narrow_resize';await wait(()=>innerWidth<=900);assert(innerWidth<=900,'narrow_window_not_exercised');
 await window.__p8Result(JSON.stringify({passed:true,actualBackend:true,actualWebView2:true,defaultNoModel:true,tab:true,shiftTab:true,escapePreservedDraft:true,confirmedDiscard:true,dark:true,viewportWidth:innerWidth,viewportHeight:innerHeight}));
 })().catch(error=>window.__p8Result(JSON.stringify({passed:false,error:String(error.message)})));});`)
	timer := time.AfterFunc(50*time.Second, func() { window.Dispatch(window.Destroy) })
	defer timer.Stop()
	window.Navigate(origin + "/#token=p8-synthetic-local-test")
	window.Run()
	select {
	case value := <-result:
		value["platform"] = runtime.GOOS + "/" + runtime.GOARCH
		if path := os.Getenv("LAKE_P8_WINDOWS_REPORT"); path != "" {
			raw, _ := json.MarshalIndent(value, "", "  ")
			if os.WriteFile(path, append(raw, '\n'), 0600) != nil {
				t.Fatal("cannot save UI evidence")
			}
		}
		if value["passed"] != true {
			t.Fatalf("Windows strategy UI failed: %v", value["error"])
		}
	default:
		t.Fatal("Windows strategy UI did not report completion")
	}
}
