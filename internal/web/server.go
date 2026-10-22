package web

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/extensions"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Options struct {
	Home, DataDir, Token, DevOrigin string
	Port                            int
	Open                            bool
	DynamicPort                     bool
	Static                          fs.FS
	Output                          io.Writer
}
type Server struct {
	Extensions         *extensions.Manager
	draftCompletions   sync.Map
	progressSummaryMu  sync.Mutex
	progressSummaries  map[string]*progressSummaryState
	progressRunning    int
	scheduleMu         sync.Mutex
	schedulerWorkers   sync.WaitGroup
	workflowMu         sync.Mutex
	workflowCancels    map[string]context.CancelFunc
	messageMu          sync.Mutex
	runningMessages    map[string]bool
	bindingMu          sync.Mutex
	accessMu           sync.Mutex
	terminalGrants     map[string]TerminalAccess
	terminalWriters    map[string]string
	manualBindings     map[string]TerminalAccess
	manualBorrowers    map[string]string
	Store              *Store
	Models             *Models
	HexHubMCP          string
	HexHubLocalAssets  func(context.Context) ([]Object, error)
	Terminals          *Terminals
	Engine             *ai.Engine
	Context            context.Context
	cancel             context.CancelFunc
	options            Options
	token              string
	generated          bool
	workers            sync.WaitGroup
	closeOnce          sync.Once
	gate               sync.RWMutex
	closed             bool
	http               *http.Server
	listener           net.Listener
	streamSlots        chan struct{}
	connectionMu       sync.Mutex
	connectionFailures map[string]hostConnectionFailure
	hostKeyMu          sync.Mutex
	hostKeyPrompts     map[string]*sshTrustPrompt
}

func New(ctx context.Context, options Options) (server *Server, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("cannot initialize Go backend")
			if server != nil {
				server.Close()
			}
			server = nil
		}
	}()
	if options.Home == "" {
		options.Home = os.Getenv("LAKE_HOME")
	}
	if options.Home == "" {
		h, e := os.UserHomeDir()
		if e != nil {
			return nil, e
		}
		options.Home = filepath.Join(h, ".lake")
	}
	options.Home, err = filepath.Abs(options.Home)
	if err != nil {
		return nil, err
	}
	if options.DataDir == "" {
		options.DataDir = os.Getenv("LAKE_WEB_DATA_DIR")
	}
	if options.DataDir == "" {
		options.DataDir = filepath.Join(options.Home, "web-agent")
	}
	if err = prepareMagpieConfig(options.Home); err != nil {
		return nil, err
	}
	if options.Token == "" {
		options.Token = os.Getenv("LAKE_WEB_TOKEN")
	}
	if options.Port == 0 && !options.DynamicPort {
		options.Port = 4177
	}
	if options.Port < 0 || options.Port > 65535 {
		return nil, errors.New("invalid web port")
	}
	if options.Output == nil {
		options.Output = os.Stdout
	}
	token := options.Token
	generated := token == ""
	if generated {
		var b [32]byte
		mustRand(b[:])
		token = fmt.Sprintf("%x", b)
	}
	child, cancel := context.WithCancel(ctx)
	server = &Server{Context: child, cancel: cancel, options: options, token: token, generated: generated, streamSlots: make(chan struct{}, 4)}
	store, e := OpenStore(options.DataDir)
	if e != nil {
		cancel()
		return nil, e
	}
	server.Store = store
	server.Extensions = extensions.NewManager(extensions.NewStore(options.Home))
	server.Models = &Models{Home: options.Home, Dir: options.DataDir}
	server.Terminals = NewTerminals(store, server.Models, token)
	server.Terminals.ResolveAccess = server.terminalOwner
	server.Terminals.OnClose = server.revokeTerminal
	server.Terminals.OnControl = func(tid string, holder any) {
		if holder != "agent" {
			server.revokeTerminal(tid)
		}
	}
	server.Terminals.HostKeyApproval = server.ensureHostKey
	server.Engine, e = ai.New(filepath.Join(options.DataDir, "ai"), server.bridge, server.event)
	if e != nil {
		store.Close()
		cancel()
		return nil, e
	}
	server.Engine.RuntimeDir = filepath.Join(options.DataDir, "adk")
	server.Engine.SetSRERepository(store)
	server.Engine.Strategies = server.strategyProvider
	server.Engine.CorrectionGuard = server.strategyCorrectionGuard
	store.RecoverSRETasks()
	if err = server.startScheduler(); err != nil {
		server.Close()
		return nil, err
	}
	return server, nil
}
func (b *Server) Start() error {
	if err := b.reconcilePersistedMemoryOutboxes(); err != nil {
		return err
	}
	_ = b.reconcilePersistedStrategyOutboxes()
	b.Store.RecoverMemoryJobs()
	_ = b.Store.ReconcileProjectMemoryFiles()
	l, e := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", b.options.Port))
	if e != nil {
		return e
	}
	b.listener = l
	b.workers.Add(1)
	go b.runMemoryWorker()
	b.workers.Add(1)
	go b.runStrategyWorker()
	b.workers.Add(1)
	go b.runExperimentWorker()
	b.workers.Add(1)
	go func() {
		defer b.workers.Done()
		b.Models.RefreshStoredReasoning(b.Context)
	}()
	b.options.Port = l.Addr().(*net.TCPAddr).Port
	must(atomicFile(filepath.Join(b.options.DataDir, "runtime.json"), []byte(jsonText(Object{"origin": fmt.Sprintf("http://localhost:%d", b.options.Port), "token": b.token, "pid": os.Getpid()}))))
	b.http = &http.Server{Handler: b, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384, BaseContext: func(net.Listener) context.Context { return b.Context }}
	address := fmt.Sprintf("http://localhost:%d", b.options.Port)
	fmt.Fprintf(b.options.Output, "Lake Go backend listening at %s\n", address)
	if b.options.Open {
		program := "xdg-open"
		if runtime.GOOS == "darwin" {
			program = "open"
		}
		args := []string{address + "/#token=" + url.QueryEscape(b.token)}
		if runtime.GOOS == "windows" {
			program = "rundll32.exe"
			args = append([]string{"url.dll,FileProtocolHandler"}, args...)
		}
		cmd := exec.Command(program, args...)
		if cmd.Start() == nil {
			go cmd.Wait()
		} else {
			fmt.Fprintln(b.options.Output, "Browser could not open; access URL:", address+"/#token="+url.QueryEscape(b.token))
		}
	} else if b.generated {
		fmt.Fprintln(b.options.Output, "Startup access URL:", address+"/#token="+url.QueryEscape(b.token))
	}
	errc := make(chan error, 1)
	go func() { errc <- b.http.Serve(l) }()
	select {
	case <-b.Context.Done():
		return nil
	case e := <-errc:
		if errors.Is(e, http.ErrServerClosed) {
			return nil
		}
		return e
	}
}
func (b *Server) Close() {
	b.closeOnce.Do(func() {
		if b.Models != nil {
			b.Models.cancelCapabilityDetections()
		}
		if b.cancel != nil {
			b.cancel()
		}
		if b.http != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			b.http.Shutdown(ctx)
			cancel()
			b.http.Close()
		}
		b.gate.Lock()
		defer b.gate.Unlock()
		b.closed = true
		if b.cancel != nil {
			b.cancel()
		}
		if b.Extensions != nil {
			b.Extensions.Close()
		}
		if b.Engine != nil {
			b.Engine.Shutdown()
		}
		if b.Terminals != nil {
			b.Terminals.Shutdown()
		}
		b.schedulerWorkers.Wait()
		b.workers.Wait()
		if b.http != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			b.http.Shutdown(ctx)
		}
		if b.listener != nil {
			os.Remove(filepath.Join(b.options.DataDir, "runtime.json"))
		}
		if b.Store != nil {
			b.Store.Close()
		}
	})
}
func text(value any, field string, max int) string {
	s, ok := value.(string)
	if !ok || strings.TrimSpace(s) == "" || len([]rune(s)) > max {
		fail(400, fmt.Sprintf("%s must be nonempty text (max %d characters)", field, max))
	}
	return strings.TrimSpace(s)
}
func body(w http.ResponseWriter, r *http.Request, max int64) Object {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		fail(415, "Content-Type must be application/json")
	}
	data, e := io.ReadAll(http.MaxBytesReader(w, r.Body, max))
	if e != nil {
		var big *http.MaxBytesError
		if errors.As(e, &big) {
			fail(413, "Request body too large")
		}
		fail(400, "Invalid JSON body")
	}
	var v Object
	if json.Unmarshal(data, &v) != nil || v == nil {
		fail(400, "Expected JSON object")
	}
	return v
}
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func (b *Server) authorized(r *http.Request) bool {
	exact := func(s string) bool { return subtle.ConstantTimeCompare([]byte(s), []byte(b.token)) == 1 }
	if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") && exact(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")) {
		return true
	}
	if c, e := r.Cookie("lake_web_token"); e == nil && exact(c.Value) {
		return true
	}
	return false
}
func (b *Server) protect(r *http.Request) {
	allowedHost := set(fmt.Sprintf("localhost:%d 127.0.0.1:%d [::1]:%d", b.options.Port, b.options.Port, b.options.Port))
	origins := set(fmt.Sprintf("http://localhost:%d http://127.0.0.1:%d http://[::1]:%d", b.options.Port, b.options.Port, b.options.Port))
	if b.options.DevOrigin != "" {
		u, e := url.Parse(b.options.DevOrigin)
		if e == nil {
			allowedHost[u.Host] = true
			origins[b.options.DevOrigin] = true
		}
	}
	if !allowedHost[r.Host] {
		fail(403, "Host not allowed")
	}
	origin := r.Header.Get("Origin")
	if origin != "" && !origins[origin] {
		fail(403, "Origin not allowed")
	}
	if (r.Method == "POST" || r.Method == "PUT" || r.Method == "PATCH" || r.Method == "DELETE") && origin == "" && r.Header.Get("Sec-Fetch-Site") != "" && r.Header.Get("Sec-Fetch-Site") != "none" {
		fail(403, "Origin required")
	}
}
func (b *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b.gate.RLock()
	defer b.gate.RUnlock()
	if b.closed {
		reply(w, 503, Object{"error": "Service stopped"})
		return
	}
	defer func() {
		if p := recover(); p != nil {
			f, ok := p.(*Failure)
			if !ok {
				f = &Failure{500, "Internal server error"}
			}
			reply(w, f.Status, Object{"error": f.Message})
		}
	}()
	b.protect(r)
	name := r.URL.Path
	method := r.Method
	if !strings.HasPrefix(name, "/api/") {
		b.static(w, r)
		return
	}
	if !b.authorized(r) {
		if !(name == "/api/bootstrap" && method == "GET" && b.generated && b.options.DevOrigin != "") {
			fail(401, "Authentication required")
		}
	}
	if name == "/api/bootstrap" && method == "GET" {
		http.SetCookie(w, &http.Cookie{Name: "lake_web_token", Value: b.token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
		model, selection := b.Models.ActiveSelection()
		var modelName any
		var modelID any
		imageInput := false
		if model != nil {
			modelName = model.Name
			modelID = ai.ModelIdentity(*model)
			imageInput = model.SupportsImageInput
		}
		reply(w, 200, Object{"authenticated": true, "modelConfigured": model != nil, "modelName": modelName, "modelId": modelID, "modelSelection": selection, "supportsImageInput": imageInput, "terminalMode": "pty", "aiRuntime": "go", "backendRuntime": "go"})
		return
	}
	if b.sreRoute(w, r, name, method) {
		return
	}
	if b.scheduleRoute(w, r, name, method) {
		return
	}
	if b.workflowRoute(w, r, name, method) {
		return
	}
	if b.presentationRoute(w, r, name, method) {
		return
	}
	if b.navigationTrashRoute(w, r, name) {
		return
	}
	if b.extensionRoute(w, r, name) {
		return
	}
	if b.providerRoute(w, r, name, method) {
		return
	}
	if b.strategyRoute(w, r, name) {
		return
	}
	if b.projectMemoryRoute(w, r, name, method) {
		return
	}
	if name == "/api/settings/model" {
		switch method {
		case "GET":
			reply(w, 200, b.Models.Settings())
			return
		case "PUT":
			cfg := b.Models.Input(body(w, r, 16384))
			b.Models.Save(cfg)
			reply(w, 200, b.Models.Settings())
			return
		case "DELETE":
			b.Models.Clear()
			reply(w, 200, b.Models.Settings())
			return
		}
	}
	if name == "/api/settings/model/test" && method == "POST" {
		data := body(w, r, 16384)
		cfg := b.Models.Input(data)
		result, e := b.handleAI(r.Context(), "testModel", "", cfg)
		must(e)
		reply(w, 200, result)
		return
	}
	if name == "/api/settings/model/capacity" && method == "GET" {
		model := b.Models.WithCapacity(r.Context(), b.Models.Active())
		if model == nil {
			reply(w, 200, Object{"limit": 0})
			return
		}
		reply(w, 200, Object{"modelId": ai.ModelIdentity(*model), "limit": model.ContextLimit, "source": model.ContextLimitSource})
		return
	}
	if name == "/api/settings/model/state" && method == "GET" {
		reply(w, 200, b.Models.SyncState())
		return
	}
	if name == "/api/settings/model/available" && method == "GET" {
		if result, exists := b.Models.ConfiguredProviderModels(); exists {
			reply(w, 200, result)
			return
		}
		cfg := b.Models.Active()
		if cfg == nil {
			reply(w, 200, Object{"models": []string{}, "message": "尚未配置模型"})
		} else {
			result, e := b.handleAI(r.Context(), "models", "", cfg)
			must(e)
			reply(w, 200, result)
		}
		return
	}
	if name == "/api/settings/ssh/keys" && method == "POST" {
		data := body(w, r, 2048)
		reply(w, 200, listSSHKeys(stringOf(data["directory"])))
		return
	}
	if name == "/api/commands/policy" && method == "POST" {
		command := text(body(w, r, 16384)["command"], "command", 2000)
		if !validCommand(command) {
			fail(400, "Invalid command")
		}
		if b.Terminals.containsCredential(command) {
			fail(400, "Commands must not contain credentials")
		}
		reply(w, 200, CommandPolicy(command))
		return
	}
	if name == "/api/catalog" && method == "GET" {
		catalog := b.Store.Catalog()
		for _, terminal := range objects(catalog["terminals"]) {
			terminal["interactive"] = b.Terminals.UserInteractive(stringOf(terminal["id"]))
		}
		reply(w, 200, catalog)
		return
	}
	if name == "/api/projects" && method == "POST" {
		reply(w, 201, b.Store.CreateProject(text(body(w, r, 16384)["name"], "name", 120)))
		return
	}
	parts := strings.Split(strings.Trim(name, "/"), "/")
	if len(parts) == 3 && parts[0] == "api" && parts[1] == "resources" && method == "PATCH" {
		b.editTerminalResourceRoute(w, r, parts[2])
		return
	}
	if len(parts) == 4 && parts[0] == "api" && parts[1] == "resources" && parts[3] == "terminals" && method == "GET" {
		b.Store.Resource(parts[2])
		terminals := []Object{}
		for _, terminal := range b.Store.ResourceTerminals(parts[2]) {
			if b.Terminals.UserInteractive(stringOf(terminal["id"])) {
				terminal["interactive"] = true
				terminals = append(terminals, terminal)
			}
		}
		reply(w, 200, Object{"terminals": terminals})
		return
	}
	if len(parts) == 4 && parts[0] == "api" && parts[1] == "resources" && parts[3] == "terminal-context" && method == "POST" {
		b.Store.Resource(parts[2])
		// Existing manual shells may predate resource runtime scopes. Reuse
		// their owner for terminal access without navigating to that chat.
		terms := b.Store.ResourceTerminals(parts[2])
		for i := len(terms) - 1; i >= 0; i-- {
			t := terms[i]
			if t["holder"] == "user" && (t["status"] == "ready" || t["status"] == "busy") && b.Terminals.UserInteractive(stringOf(t["id"])) {
				reply(w, 200, Object{"sessionId": t["sessionId"]})
				return
			}
		}
		scope := b.Store.ResourceTerminalSession(parts[2])
		reply(w, 200, Object{"sessionId": scope["id"]})
		return
	}
	if (len(parts) == 4 || len(parts) == 5) && parts[0] == "api" && parts[1] == "resources" && parts[3] == "terminals" && method == "DELETE" {
		var terminals []Object
		if len(parts) == 5 {
			terminals = []Object{b.Store.ResourceTerminal(parts[2], parts[4])}
		} else {
			for _, terminal := range b.Store.ResourceTerminals(parts[2]) {
				if b.Terminals.UserInteractive(stringOf(terminal["id"])) {
					terminals = append(terminals, terminal)
				}
			}
		}
		for _, t := range terminals {
			b.closeTerminalByUser(stringOf(t["sessionId"]), stringOf(t["id"]))
		}
		reply(w, 200, Object{"closed": len(terminals)})
		return
	}
	if len(parts) == 4 && parts[0] == "api" && parts[1] == "projects" && method == "POST" {
		limit := int64(16384)
		if parts[3] == "resources" || parts[3] == "resource-import-preview" {
			// A 1 MB private key may expand when JSON-escaped; the key itself
			// is bounded and validated by prepareSSH before saving.
			limit = 8 << 20
		}
		data := body(w, r, limit)
		switch parts[3] {
		case "resource-tree":
			reply(w, 200, Object{"nodes": b.Store.EditResourceTree(parts[2], data)})
			return
		case "resource-import-preview":
			reply(w, 200, b.previewResourceImport(r.Context(), parts[2], "", data))
			return
		case "resource-import":
			reply(w, 201, b.commitResourceImport(parts[2], "", stringOf(data["planId"]), data["indexes"]))
			return
		case "resources":
			kind := stringOf(data["kind"])
			// A folder the new resource is filed under; empty means the root level.
			parent := optionalTreeID(data["parentId"])
			if parent != "" {
				b.Store.treeParent(parts[2], parent, "")
			}
			var config Object
			if kind == "ssh" {
				b.Store.Project(parts[2])
				var cleanup func()
				config, cleanup = prepareSSH(b.Models.Home, object(data["ssh"]))
				created := false
				defer func() {
					if !created {
						cleanup()
					}
				}()
				result := b.Store.CreateResource(parts[2], text(data["name"], "name", 120), kind, config)
				created = true
				b.fileResource(parts[2], result, parent)
				reply(w, 201, result)
				return
			} else if set("database docker redis")[kind] {
				config = validateService(kind, object(data["settings"]))
			} else {
				fail(400, "Unsupported resource type")
			}
			result := b.Store.CreateResource(parts[2], text(data["name"], "name", 120), kind, config)
			b.fileResource(parts[2], result, parent)
			reply(w, 201, result)
			return
		case "sessions":
			validateIDs(data["resourceIds"])
			title := ""
			if value := data["title"]; value != nil {
				raw, ok := value.(string)
				if !ok {
					fail(400, "title must be text")
				}
				if strings.TrimSpace(raw) != "" {
					title = text(raw, "title", 200)
				}
			}
			session := b.Store.CreateSession(parts[2], title, stringsOf(data["resourceIds"]))
			if data["terminalReuse"] != nil {
				created := false
				defer func() {
					if !created {
						b.Store.DeleteSession(stringOf(session["id"]))
					}
				}()
				selection := object(data["terminalReuse"])
				t := b.Store.projectTerminal(stringOf(session["id"]), stringOf(selection["terminalId"]))
				b.bindManualTerminalForHuman(stringOf(session["id"]), []Object{{"asset_ref": t["resourceId"]}}, selection)
				created = true
			}
			reply(w, 201, session)
			return
		}
	}
	if name == "/api/ai/presets" {
		switch method {
		case "GET":
			result, e := b.handleAI(r.Context(), "presets", "", Object{})
			must(e)
			reply(w, 200, result)
			return
		case "POST", "DELETE":
			op := "savePreset"
			if method == "DELETE" {
				op = "deletePreset"
			}
			result, e := b.handleAI(r.Context(), op, "", body(w, r, 128000))
			aiFailure(e)
			reply(w, 200, result)
			return
		}
	}
	if len(parts) >= 3 && parts[0] == "api" && parts[1] == "sessions" {
		id := parts[2]
		b.Store.Session(id)
		if len(parts) == 3 && method == "PATCH" {
			data := body(w, r, 4096)
			for key := range data {
				if key != "title" {
					fail(400, "编辑会话仅支持修改名称")
				}
			}
			title := text(data["title"], "会话名称", 200)
			if b.Terminals.titleInput(title) != title {
				fail(400, "名称包含敏感凭据，请改用描述性名称")
			}
			reply(w, 200, b.Store.RenameSession(id, title))
			return
		}
		if len(parts) == 4 && parts[3] == "host-key" && method == "POST" {
			data := body(w, r, 4096)
			accept, ok := data["accept"].(bool)
			if !ok {
				fail(400, "accept must be boolean")
			}
			b.decideHostKey(id, text(data["id"], "id", 100), accept, stringOf(data["fingerprint"]))
			b.Store.Touch(id)
			reply(w, 200, Object{"ok": true})
			return
		}
		if len(parts) == 3 && method == "DELETE" {
			b.messageMu.Lock()
			defer b.messageMu.Unlock()
			if b.runningMessages[id] {
				fail(409, "请先停止 AI，并等待本轮结束")
			}
			snap := b.sessionSnapshot(id)
			view, e := b.Engine.Snapshot(id)
			aiFailure(e)
			if view.Status == "running" || view.Status == "waiting_approval" || object(snap["session"])["status"] == "investigating" || b.hostKeyPrompt(id) != nil {
				fail(409, "请先停止 AI")
			}
			for _, t := range objects(snap["terminals"]) {
				if t["status"] == "busy" || t["status"] == "connecting" {
					fail(409, "请先中断运行命令")
				}
			}
			aiFailure(b.Engine.Clear(id))
			b.Terminals.CloseSession(id)
			b.revokeSessionTerminals(id)
			b.Store.DeleteSession(id)
			b.resetConnectionFailures(id)
			w.WriteHeader(204)
			return
		}
		if len(parts) == 5 && parts[3] == "attachments" {
			b.attachmentRoute(w, r, id, parts[4])
			return
		}
		if len(parts) == 4 {
			switch parts[3] {
			case "snapshot":
				if method == "GET" {
					snap := b.sessionSnapshot(id)
					view, e := b.Engine.Snapshot(id)
					aiFailure(e)
					snap["ai"] = b.contextView(view)
					snap["hostKeyTrust"] = b.hostKeyPrompt(id)
					reply(w, 200, snap)
					return
				}
			case "events":
				if method == "GET" {
					after := r.URL.Query().Get("after")
					if after == "" {
						after = r.Header.Get("Last-Event-ID")
					}
					if after == "" {
						after = "0"
					}
					n, e := strconv.ParseInt(after, 10, 64)
					if e != nil || n < 0 || n > 9007199254740991 || strconv.FormatInt(n, 10) != after {
						fail(400, "after must be a nonnegative event cursor")
					}
					b.sse(w, r, id, n)
					return
				}
			case "attachments":
				b.attachmentRoute(w, r, id, "")
				return
			case "text-files":
				if method == "POST" {
					data := body(w, r, 8<<20)
					project := stringOf(b.Store.Session(id)["projectId"])
					reply(w, 201, b.saveImportSource(project, id, stringOf(data["name"]), stringOf(data["text"])))
					return
				}
			case "completion":
				if method == "POST" {
					b.completeDraft(w, r, id)
					return
				}
			case "message-queue":
				b.messageQueueRoute(w, r, id)
				return
			case "messages":
				if method == "POST" {
					reply(w, 202, b.submitHumanMessage(id, body(w, r, 8<<20)))
					return
				}
			case "terminals":
				if method == "POST" {
					data := body(w, r, 16384)
					ref := text(data["resourceId"], "resourceId", 100)
					if data["interactive"] != nil && data["interactive"] != true && data["interactive"] != false {
						fail(400, "interactive must be boolean")
					}
					if data["interactive"] == true {
						reply(w, 201, b.Terminals.OpenInteractive(r.Context(), id, ref, stringOf(data["shell"])))
						return
					}
					if data["shell"] != nil {
						reply(w, 201, b.Terminals.OpenShell(r.Context(), id, ref, shellName(data["shell"])))
					} else {
						reply(w, 201, b.Terminals.Open(r.Context(), id, ref))
					}
					return
				}
			}
		}
		if len(parts) >= 4 && parts[3] == "ai" {
			op := "snapshot"
			if len(parts) == 5 {
				op = parts[4]
			} else if len(parts) != 4 {
				fail(404, "API route not found")
			}
			if method == "GET" {
				if op == "plans" {
					plans, err := b.Engine.ProposedPlans(id)
					aiFailure(err)
					reply(w, 200, Object{"plans": plans})
					return
				}
				if op == "mode" {
					reply(w, 200, Object{"mode": b.conversationMode(id)})
					return
				}
				if op == "reasoning" {
					reply(w, 200, b.reasoningSettings(r.Context(), id))
					return
				}
				if op == "options" {
					options := b.sessionOptions(id)
					// The composer manages reasoning separately; stale full-form saves
					// must not overwrite a more recent reasoning selection.
					delete(options, "reasoningEffort")
					delete(options, "reasoningModelId")
					delete(options, "conversationMode")
					reply(w, 200, options)
					return
				}
				if set("snapshot history tools references")[op] {
					data := b.Store.Options(id)
					if op == "snapshot" {
						before, e := strconv.Atoi(defaultText(r.URL.Query().Get("before"), "0"))
						if e != nil || before < 0 {
							fail(400, "Invalid card cursor")
						}
						data["before"] = before
					}
					result, e := b.handleAI(r.Context(), op, id, data)
					aiFailure(e)
					if view, ok := result.(ai.View); ok {
						result = b.contextView(view)
					}
					reply(w, 200, result)
					return
				}
			}
			if method == "POST" {
				if op == "mode" {
					reply(w, 200, b.setConversationMode(id, body(w, r, 16384)))
					return
				}
				if op == "executePlan" {
					reply(w, 202, b.executeProposedPlan(id, body(w, r, 16384)))
					return
				}
				if op == "progress-summary" {
					b.progressSummaryRoute(w, r, id)
					return
				}
				if op == "reasoning" {
					reply(w, 200, b.setReasoning(r.Context(), id, body(w, r, 16384)))
					return
				}
				if op == "configure" {
					updates := body(w, r, 128000)
					if _, exists := updates["conversationMode"]; exists {
						fail(400, "请通过模式切换入口修改会话模式")
					}
					reply(w, 200, b.configure(id, updates))
					return
				}
				if set("abort questionReply agentQuestionReply decision cancelAgent agentDecision agentDetails resolveOperation clear clearReferences rollback compact restore undoFile extractPreset")[op] {
					limit := int64(128000)
					if op == "restore" {
						limit = 32 << 20
					}
					data := body(w, r, limit)
					status := b.Store.Session(id)["status"]
					if !set("abort questionReply agentQuestionReply decision cancelAgent agentDecision agentDetails extractPreset")[op] && (status == "investigating" || status == "waiting_approval") {
						fail(409, "AI 正在运行，请先停止")
					}
					if op == "compact" || op == "undoFile" || op == "extractPreset" {
						b.configure(id, nil)
					}
					if op == "abort" {
						b.cancelSessionWorkflow(id)
						b.pausePendingMessageQueue(id)
						b.cancelHostKeys(id)

					}
					result, e := b.handleAI(r.Context(), op, id, data)
					aiFailure(e)
					b.Store.Touch(id)
					reply(w, 200, result)
					return
				}
			}
		}
		if len(parts) == 8 && parts[3] == "messages" && parts[5] == "images" && method == "GET" {
			fail(404, "API route not found")
		}
		if len(parts) == 7 && parts[3] == "messages" && parts[5] == "images" && method == "GET" {
			im := b.Store.Image(id, parts[4], parts[6])
			bytes, e := base64.StdEncoding.DecodeString(stringOf(im["base64"]))
			must(e)
			w.Header().Set("Content-Type", stringOf(im["mimeType"]))
			w.Header().Set("Cache-Control", "private, no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Write(bytes)
			return
		}
		if len(parts) == 5 && parts[3] == "terminals" && parts[4] == "available" && method == "GET" {
			reply(w, 200, b.Store.AvailableTerminals(id))
			return
		}
		if len(parts) == 6 && parts[3] == "terminals" && parts[5] == "ai-scope" && method == "POST" {
			data := body(w, r, 16384)
			tid := parts[4]
			term := b.terminalForSession(id, tid)
			if data["generation"] != term["generation"] {
				fail(409, "Terminal generation changed")
			}
			scope := b.Store.ResolveTerminalAISession(id, tid)
			sid := stringOf(scope["id"])
			needsAdoption := false
			func() {
				defer func() {
					if recover() != nil {
						needsAdoption = true
					}
				}()
				b.ResolveTerminalAccess(sid, tid, false)
			}()
			opts := b.Store.Options(sid)
			needsAdoption = needsAdoption || opts["terminal_id"] != tid
			reply(w, 200, Object{"shellRecreated": stringOf(opts["terminal_generation"]) != "" && opts["terminal_generation"] != term["generation"], "sessionId": sid, "terminalId": tid, "generation": term["generation"], "ownerSessionId": term["sessionId"], "ownerTitle": b.Store.Session(stringOf(term["sessionId"]))["title"], "needsAdoption": needsAdoption})
			return
		}
		if len(parts) == 6 && parts[3] == "terminals" {
			tid, op := parts[4], parts[5]
			if method == "GET" && op == "history" {
				owner := b.terminalOwner(id, tid, false)
				var history Object
				if r.URL.Query().Get("outputOnly") == "1" {
					history = b.Store.TerminalOutput(owner, tid)
				} else {
					history = b.Store.History(owner, tid)
				}
				object(history["terminal"])["interactive"] = b.Terminals.UserInteractive(tid)
				reply(w, 200, history)
				return
			}
			if method == "POST" {
				b.terminalRoute(w, r, id, tid, op)
				return
			}
		}
	}
	if len(parts) == 4 && parts[0] == "api" && parts[1] == "actions" && parts[3] == "decision" && method == "POST" {
		data := body(w, r, 16384)
		decision := stringOf(data["decision"])
		if decision != "approve" && decision != "reject" {
			fail(400, "decision must be approve or reject")
		}
		a := b.Store.Action(parts[2])
		if decision == "approve" {
			b.startAction(r.Context(), a, stringOf(data["confirmation"]))
			reply(w, 202, b.Store.Action(parts[2]))
		} else {
			reply(w, 200, b.Store.Decide(parts[2], decision, "", false))
		}
		return
	}
	fail(404, "API route not found")
}
func aiFailure(e error) {
	if e != nil {
		fail(409, e.Error())
	}
}
func validateIDs(v any) {
	if v == nil {
		return
	}
	a, ok := v.([]any)
	if !ok || len(a) > 100 {
		fail(400, "resourceIds must be an array of IDs")
	}
	for _, id := range a {
		if _, ok := id.(string); !ok {
			fail(400, "resourceIds must be an array of IDs")
		}
	}
}
func (b *Server) terminalRoute(w http.ResponseWriter, r *http.Request, id, tid, op string) {
	data := body(w, r, 16384)
	switch op {
	case "adopt":
		if data["accept"] != true {
			fail(400, "Explicit terminal adoption decision required")
		}
		result := b.adoptAndBindTerminal(id, tid, text(data["generation"], "generation", 100), data["bind"] == true)
		reply(w, 200, result)
		return
	case "control":
		holder := data["holder"]
		if holder != nil && holder != "user" && holder != "agent" {
			fail(400, "holder must be user, agent, or null")
		}
		controlled := b.transferTerminal(id, tid, holder)
		if holder == "agent" {
			for _, a := range objects(b.Store.Snapshot(id)["actions"]) {
				if a["status"] == "pending" && a["risk"] == "readonly" && a["resourceId"] == controlled["resourceId"] && (a["terminalId"] == nil || a["terminalId"] == tid) {
					b.startAction(r.Context(), a, "")
					break
				}
			}
		}
		reply(w, 200, b.terminalForSession(id, tid))
		return
	case "input":
		if _, ok := data["data"].(string); !ok {
			fail(400, "data must be text")
		}
		b.Terminals.Input(id, tid, stringOf(data["data"]), false)
		reply(w, 202, Object{"accepted": true})
		return
	case "resize":
		cols, rows := integer(data["cols"]), integer(data["rows"])
		if number(data["cols"]) != float64(cols) || number(data["rows"]) != float64(rows) {
			fail(400, "Invalid terminal dimensions")
		}
		b.Terminals.Resize(id, tid, cols, rows)
		reply(w, 200, Object{"resized": true})
		return
	case "disconnect":
		b.closeTerminalByUser(id, tid)
		reply(w, 200, Object{"disconnected": true})
		return
	case "interrupt":
		b.Terminals.Interrupt(id, tid)
		reply(w, 202, Object{"interrupted": true})
		return
	case "commands":
		if data["actor"] != "user" && data["actor"] != "agent" {
			fail(400, "actor must be user or agent")
		}
		if data["actor"] == "agent" {
			fail(403, "Agent commands require action approval")
		}
		command := stringOf(data["command"])
		if !validCommand(command) {
			fail(400, "Invalid command")
		}
		p := CommandPolicy(command)
		if p.Risk != "readonly" && data["confirmed"] != true {
			fail(400, "State-changing command requires confirmation")
		}
		resource := b.Store.Resource(stringOf(b.terminalForSession(id, tid)["resourceId"]))
		if p.Risk == "dangerous" && data["confirmation"] != "执行 "+stringOf(resource["name"]) {
			fail(400, "Dangerous command requires explicit target confirmation")
		}
		reply(w, 202, b.Terminals.Execute(id, tid, "user", command, ""))
		return
	}
	fail(404, "Terminal operation unavailable")
}
func (b *Server) startAction(ctx context.Context, a Object, confirmation string) {
	var tidObj Object
	if tid := stringOf(a["terminalId"]); tid != "" {
		tidObj = b.terminalForSession(stringOf(a["sessionId"]), tid)
		b.ResolveTerminalAccess(stringOf(a["sessionId"]), tid, true)
		if integer(tidObj["contextVersion"]) != integer(a["contextVersion"]) {
			fail(409, "Terminal context changed")
		}
	} else {
		tidObj = b.Store.TerminalForAction(a)
	}
	if tidObj["holder"] != "agent" {
		fail(409, "Transfer a ready terminal for this resource to the agent before execution")
	}
	aid, id, tid := stringOf(a["id"]), stringOf(a["sessionId"]), stringOf(tidObj["id"])
	approved := b.Store.Decide(aid, "approve", confirmation, false)
	var entry Object
	func() {
		defer func() {
			if p := recover(); p != nil {
				b.Store.UnknownAction(aid)
				panic(p)
			}
		}()
		entry = b.Terminals.Execute(id, tid, "agent", stringOf(approved["command"]), aid)
	}()
	b.workers.Add(1)
	go func() {
		defer b.workers.Done()
		defer func() { recover() }()
		result := b.Terminals.Wait(b.Context, id, tid, stringOf(entry["id"]))
		if result["exitCode"] == nil || b.Context.Err() != nil {
			return
		}
		if b.terminalForSession(id, tid)["holder"] != "agent" {
			return
		}
		messages := objects(b.Store.Snapshot(id)["messages"])
		goal := ""
		for _, m := range messages {
			if m["role"] == "user" && stringOf(m["createdAt"]) <= stringOf(a["createdAt"]) {
				goal = stringOf(m["text"])
			}
		}
		if goal == "" {
			b.Store.Status(id, "completed")
			return
		}
		b.messageMu.Lock()
		defer b.messageMu.Unlock()
		b.launchMessageLocked(id, humanMessage{Text: goal})
	}()
}
func (b *Server) sse(w http.ResponseWriter, r *http.Request, id string, after int64) {
	b.Store.Session(id)
	// HTTP/1 browsers allow six connections per origin. Reserve capacity for
	// snapshots and operations when several tabs keep event streams open.
	select {
	case b.streamSlots <- struct{}{}:
		defer func() { <-b.streamSlots }()
	default:
		w.Header().Set("Retry-After", "3")
		fail(http.StatusTooManyRequests, "实时连接已满，请使用会话查询刷新。")
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		fail(500, "Streaming unavailable")
	}
	ch, unsubscribe := b.Store.Subscribe()
	defer unsubscribe()
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	write := func(s string) bool {
		controller.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_, e := io.WriteString(w, s)
		if e != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !write(": connected\n\n") {
		return
	}
	send := func(ev Object) bool {
		n := int64(integer(ev["seq"]))
		if ev["sessionId"] != id || n <= after {
			return true
		}
		after = n
		return write(fmt.Sprintf("id: %d\nevent: %s\ndata: %s\n\n", n, ev["type"], jsonText(ev)))
	}
	for {
		events := b.Store.Events(id, after)
		for _, ev := range events {
			if !send(ev) {
				return
			}
		}
		if len(events) < 1000 {
			break
		}
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-b.Context.Done():
			return
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok || !send(ev) {
				return
			}
		case <-heartbeat.C:
			if !write(": heartbeat\n\n") {
				return
			}
		}
	}
}
func (b *Server) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		fail(404, "Page not found")
	}
	if b.options.Static == nil {
		fail(503, "React assets missing; run scripts/build_lake.sh")
	}
	if strings.ContainsAny(r.URL.Path, "\\\x00") {
		fail(400, "Invalid path")
	}
	file := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if file == "" {
		file = "index.html"
	}
	f, e := b.options.Static.Open(file)
	if e != nil {
		if strings.HasPrefix(file, "assets/") {
			fail(404, "Asset not found")
		}
		file = "index.html"
		f, e = b.options.Static.Open(file)
	}
	if e != nil {
		fail(404, "Page not found")
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil || info.IsDir() {
		fail(404, "Page not found")
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Type", mime.TypeByExtension(path.Ext(file)))
	if r.Method == "HEAD" {
		w.WriteHeader(200)
		return
	}
	io.Copy(w, f)
}
