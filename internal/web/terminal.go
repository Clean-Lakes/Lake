package web

import (
	"context"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/hinshun/vt10x"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const outputLimit = 32768

type terminalJob struct {
	entry                    Object
	marker, output, actionID string
	done                     chan struct{}
	timer                    *time.Timer
	changed                  bool
	manual                   bool
	startMarker              string
	started                  bool
}
type terminalDevice interface {
	io.ReadWriteCloser
	WriteString(string) (int, error)
}
type liveTerminal struct {
	mu                                        sync.Mutex
	pty                                       terminalDevice
	cmd                                       *exec.Cmd
	id, session, readyMarker, pending, output string
	ready, closed                             bool
	interactive, rawUserPending               bool
	inputSeen, promptRedraw                   bool
	userInputPending, hiddenAgentOutput       bool
	connected                                 chan struct{}
	connectErr                                error
	startupExitCode                           *int
	connectionTarget                          string
	startupCause                              string
	startup, flush                            *time.Timer
	job                                       *terminalJob
	screen                                    vt10x.Terminal
	screenPartial                             string
	utf8Partial                               string
	capturedAt                                string
	shell                                     string
	remote                                    bool
	hooks                                     bool
	hookPartial                               string
	rawOrigin                                 string
	scrollback                                []string
	initEchoDropped                           bool
}
type Terminals struct {
	ResolveAccess   func(string, string, bool) string
	OnClose         func(string)
	OnControl       func(string, any)
	mu              sync.Mutex
	live            map[string]*liveTerminal
	jobs            map[string]*terminalJob
	store           *Store
	models          *Models
	token           string
	wg              sync.WaitGroup
	closing         bool
	KnownHosts      string
	secretMu        sync.RWMutex
	authSecrets     map[string]bool
	askpassProgram  string
	HostKeyApproval func(context.Context, string, string) string
}

func NewTerminals(store *Store, models *Models, token string) *Terminals {
	return &Terminals{live: map[string]*liveTerminal{}, jobs: map[string]*terminalJob{}, store: store, models: models, token: token, authSecrets: map[string]bool{}}
}
func tail(s string, n int) string {
	if n < 1 {
		return ""
	}
	if len(s) > n {
		s = s[len(s)-n:]
		for len(s) > 0 && !utf8.RuneStart(s[0]) {
			s = s[1:]
		}
	}
	return s
}

var privateKeyBlock = regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)`)

func (t *Terminals) redact(s string) string {
	// Flushes and screen reads sanitize accumulated snapshots, not isolated PTY
	// chunks. Match complete credentials even when received across several reads.
	// A suffix matching only a credential prefix is ordinary terminal input too
	// (for example the "s" in "ls"); replacing it corrupts echo and cursor replay.
	s = privateKeyBlock.ReplaceAllString(s, "[PRIVATE KEY REDACTED]")
	secrets := t.authenticationSecrets()
	if cfg := t.models.Active(); cfg != nil {
		secrets = append(secrets, cfg.Key)
	}
	for _, secret := range secrets {
		if len(secret) == 0 {
			continue
		}
		s = strings.ReplaceAll(s, secret, "[REDACTED]")
	}
	return s
}
func (t *Terminals) Open(ctx context.Context, id, ref string) Object {
	return t.open(ctx, id, ref, "")
}
func (t *Terminals) open(ctx context.Context, id, ref, selectedShell string, interactiveMode ...bool) Object {
	interactive := len(interactiveMode) > 0 && interactiveMode[0]
	r := t.store.Resource(ref)
	if selectedShell == "" {
		config := object(r["settings"])
		if r["kind"] == "ssh" {
			config = object(r["ssh"])
		}
		selectedShell = shellName(config["shell"])
		if interactive && stringOf(config["shell"]) == "" {
			selectedShell = "bash"
		}
	}
	if r["kind"] != "local" && r["kind"] != "ssh" {
		fail(400, "Only host resources support terminals")
	}
	t.store.AssertResource(id, ref)
	trustedPath := ""
	if r["kind"] == "ssh" && t.HostKeyApproval != nil && t.KnownHosts == "" {
		trustedPath = t.HostKeyApproval(ctx, id, ref)
	}
	program, args := "/bin/sh", []string{}
	if r["kind"] == "local" {
		program = shellProgram(selectedShell)
		args = shellArgs(selectedShell)
	}
	// Reserve under the manager lock before spawning to enforce the limit under concurrent HTTP calls.
	t.mu.Lock()
	if t.closing || len(t.live) >= 16 {
		t.mu.Unlock()
		fail(409, "Terminal limit reached or service stopping")
	}
	var term Object
	func() {
		defer func() {
			if p := recover(); p != nil {
				t.mu.Unlock()
				panic(p)
			}
		}()
		current := t.store.Resource(ref)
		field := "settings"
		if r["kind"] == "ssh" {
			field = "ssh"
		}
		if terminalConnectionSignature(stringOf(r["kind"]), object(r[field])) != terminalConnectionSignature(stringOf(current["kind"]), object(current[field])) {
			fail(409, "资源连接配置已更新，请重新打开终端")
		}
		term = t.store.CreateTerminal(id, ref)
	}()
	tid := stringOf(term["id"])
	home, e := os.UserHomeDir()
	if e != nil {
		t.mu.Unlock()
		panic(e)
	}
	var authEnv []string
	connectionTarget := ""
	readyMarker := "\x1eLAKE_READY_" + ident() + "\x1f"
	initialization := terminalInit(selectedShell, readyMarker, interactive)
	if r["kind"] == "ssh" {
		var cfg Object
		var authSecret string
		func() {
			defer func() {
				if p := recover(); p != nil {
					t.store.TerminalStatus(id, tid, "disconnected")
					t.mu.Unlock()
					panic(p)
				}
			}()
			cfg = validateSSH(t.models.Home, object(r["ssh"]))
			if ref := stringOf(cfg["credentialRef"]); ref != "" {
				authSecret = readSSHSecret(filepath.Join(t.models.Home, "secrets"), ref)
			}
		}()
		program = "/usr/bin/ssh"
		connectionTarget = fmt.Sprintf("%s@%s:%d", stringOf(cfg["username"]), stringOf(cfg["host"]), integer(cfg["port"]))
		cfg["shell"] = selectedShell
		args = sshArguments(cfg, initialization)
		if trustedPath != "" {
			for i, v := range args {
				if strings.HasPrefix(v, "UserKnownHostsFile=") {
					args[i] = platform.SSHFileOption("UserKnownHostsFile", trustedPath)
				}
			}
		}
		if ref := stringOf(cfg["credentialRef"]); ref != "" {
			helper, e := os.Executable()
			if t.askpassProgram != "" {
				helper = t.askpassProgram
			}
			if e == nil {
				helper, e = platform.SSHAskpassProgram(helper)
			}
			if e != nil {
				t.store.TerminalStatus(id, tid, "disconnected")
				t.mu.Unlock()
				fail(503, "SSH credential helper unavailable")
			}
			root := filepath.Join(t.models.Home, "secrets")
			t.secretMu.Lock()
			t.authSecrets[authSecret] = true
			t.secretMu.Unlock()
			authEnv = []string{"SSH_ASKPASS=" + helper, "SSH_ASKPASS_REQUIRE=force", "DISPLAY=lake:0", "LAKE_SSH_ASKPASS=1", "LAKE_SSH_ASKPASS_MODE=" + stringOf(cfg["authMethod"]), "LAKE_SSH_SECRET_ROOT=" + root, "LAKE_SSH_SECRET_REF=" + ref}
		}
		if t.KnownHosts != "" {
			for i, v := range args {
				if strings.HasPrefix(v, "UserKnownHostsFile=") {
					args[i] = platform.SSHFileOption("UserKnownHostsFile", t.KnownHosts)
				}
			}
		}
	}
	var startupLog *sshStartupLog
	if r["kind"] == "ssh" && runtime.GOOS == "windows" {
		// Failure to create optional diagnostics must not block a valid login.
		startupLog, _ = newSSHStartupLog(t.models.Home)
		if startupLog != nil {
			args = append([]string{"-E", filepath.ToSlash(startupLog.path), "-o", "LogLevel=VERBOSE"}, args...)
		}
	}
	cmd := exec.Command(platform.Executable(program), args...)
	cmd.Dir = home
	cmd.Env = append(platform.Environment(home), "TERM=xterm-256color", "PS1=", "PS2=", "HISTFILE=/dev/null")
	cmd.Env = append(cmd.Env, authEnv...)
	if r["kind"] == "local" {
		cmd.Env = append(cmd.Env, "__lake_init="+initialization)
	}
	f, e := startTerminal(cmd, 100, 30)
	if e != nil {
		startupLog.discard()
		t.mu.Unlock()
		t.store.TerminalStatus(id, tid, "disconnected")
		fail(503, "Could not start terminal; verify connection configuration")
	}
	l := &liveTerminal{pty: f, cmd: cmd, id: tid, session: id, remote: r["kind"] == "ssh", interactive: interactive, promptRedraw: selectedShell != "sh", readyMarker: readyMarker, connected: make(chan struct{}), shell: selectedShell, connectionTarget: connectionTarget, screen: vt10x.New(vt10x.WithSize(100, 30))}
	t.live[tid] = l
	t.wg.Add(2)
	t.mu.Unlock()
	l.mu.Lock()
	l.startup = time.AfterFunc(15*time.Second, func() { t.closeLive(l, "Connection timed out") })
	l.mu.Unlock()
	readDone := make(chan struct{})
	go func() {
		defer t.wg.Done()
		defer close(readDone)
		buf := make([]byte, 8192)
		for {
			n, e := f.Read(buf)
			if n > 0 {
				t.receive(l, string(buf[:n]))
			}
			if e != nil {
				return
			}
		}
	}()
	go func() {
		defer t.wg.Done()
		cmd.Wait()
		startupCause := startupLog.finish()
		l.mu.Lock()
		l.startupCause = startupCause
		if l.remote && !l.ready && cmd.ProcessState != nil {
			code := cmd.ProcessState.ExitCode()
			l.startupExitCode = &code
		}
		l.mu.Unlock()
		// Drain final OpenSSH stderr before classifying a failed handshake.
		select {
		case <-readDone:
		case <-time.After(500 * time.Millisecond):
		}
		t.closeLive(l, "Terminal connection closed")
	}()
	// Drain the PTY before writing initialization. Echo and continuation prompts
	// can fill its output buffer and block a large write; do not hold l.mu while
	// writing so cancellation/timeout can still close the terminal.
	// Carry the script through the environment/SSH command channel. Only this
	// short trigger enters the PTY: large pasted initialization can overflow
	// canonical queues or race line-editor mode changes and lose bytes.
	_, e = f.WriteString(terminalInitTrigger + "\n")
	if e != nil {
		t.closeLive(l, "Connection initialization failed")
	}
	select {
	case <-ctx.Done():
		t.closeLive(l, "Connection cancelled")
		fail(503, "Terminal connection cancelled")
	case <-l.connected:
	}
	l.mu.Lock()
	err := l.connectErr
	l.mu.Unlock()
	if err != nil {
		fail(503, err.Error())
	}
	result := t.store.Terminal(id, tid)
	result["interactive"] = interactive
	return result
}
func (t *Terminals) get(id, tid string) *liveTerminal {
	t.store.Terminal(id, tid)
	t.mu.Lock()
	l := t.live[tid]
	t.mu.Unlock()
	if l == nil {
		fail(409, "Terminal disconnected")
	}
	return l
}

// terminalInitTrigger is the only command Lake types into a fresh PTY: the script
// itself travels through the environment or the SSH command channel.
const terminalInitTrigger = `eval "$__lake_init"`

// dropInitEcho removes the echoed initialization line. The trigger is written into
// the PTY, and the login shell echoes it before the script can turn echo off; a
// console repaint can repeat that line after the handshake. The echo is internal
// plumbing, so drop the first line carrying it and keep everything else — banners,
// prompts and real output — untouched.
func (l *liveTerminal) dropInitEcho(data string) string {
	if l.initEchoDropped {
		return data
	}
	at := strings.Index(data, terminalInitTrigger)
	if at < 0 {
		return data
	}
	l.initEchoDropped = true
	start := strings.LastIndexByte(data[:at], '\n') + 1
	end := at + len(terminalInitTrigger)
	if next := strings.IndexByte(data[end:], '\n'); next >= 0 {
		end += next + 1
	}
	return data[:start] + data[end:]
}

func (t *Terminals) record(l *liveTerminal, data string) {
	data = l.dropInitEcho(data)
	if data != "" {
		l.capturedAt = now()
	}
	if !l.hiddenAgentOutput {
		l.output = tail(l.output+data, outputLimit)
	}
	if l.job != nil {
		l.job.output = tail(l.job.output+data, outputLimit)
	}
	l.screenPartial += data
	for len(l.screenPartial) > 0 {
		r, n := utf8.DecodeRuneInString(l.screenPartial)
		if r == utf8.RuneError && n == 1 && !utf8.FullRuneInString(l.screenPartial) {
			break
		}
		chunk := l.screenPartial[:n]
		l.screenPartial = l.screenPartial[n:]
		cols, rows := l.screen.Size()
		cursor := l.screen.Cursor()
		if r == '\n' && cursor.Y == rows-1 && l.screen.Mode()&vt10x.ModeAltScreen == 0 {
			var line strings.Builder
			for x := 0; x < cols; x++ {
				c := l.screen.Cell(x, 0).Char
				if c == 0 {
					c = ' '
				}
				line.WriteRune(c)
			}
			l.scrollback = append(l.scrollback, strings.TrimRight(line.String(), " "))
			if len(l.scrollback) > 1000 {
				l.scrollback = l.scrollback[len(l.scrollback)-1000:]
			}
		}
		l.screen.Write([]byte(chunk))
	}
}
func (t *Terminals) receive(l *liveTerminal, data string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return
	}
	// PTY reads can end inside a UTF-8 character. Never persist or JSON-encode
	// that incomplete byte sequence: JSON would replace it and the frontend
	// would replay the changed snapshot, corrupting both text and cursor state.
	data = l.utf8Partial + data
	end := 0
	for end < len(data) && utf8.FullRuneInString(data[end:]) {
		_, size := utf8.DecodeRuneInString(data[end:])
		end += size
	}
	l.utf8Partial = data[end:]
	data = strings.ToValidUTF8(data[:end], "\ufffd")
	t.stripHooks(l, data)
}
func (t *Terminals) receivePlain(l *liveTerminal, data string) {
	l.pending += data
	if !l.ready {
		at := strings.Index(l.pending, l.readyMarker)
		if at < 0 {
			l.pending = tail(l.pending, outputLimit)
			return
		}
		l.pending = l.pending[at+len(l.readyMarker):]
		l.ready = true
		l.startup.Stop()
		t.store.TerminalStatus(l.session, l.id, "ready")
		close(l.connected)
	}
	for l.pending != "" {
		job := l.job
		if l.interactive && l.shell == "sh" && job == nil {
			if at := strings.Index(l.pending, l.readyMarker); at >= 0 {
				t.record(l, l.pending[:at])
				l.pending = l.pending[at+len(l.readyMarker):]
				if job == nil && l.rawUserPending {
					l.rawUserPending = false
					l.userInputPending = false
					t.store.TerminalStatus(l.session, l.id, "ready")
				}
				continue
			}
		}
		if job != nil && job.startMarker != "" && !job.started {
			at := strings.Index(l.pending, job.startMarker)
			if at < 0 {
				l.pending = tail(l.pending, len(job.startMarker)-1)
				break
			}
			l.pending = l.pending[at+len(job.startMarker):]
			job.started = true
		}
		prefix := ""
		at := -1
		if job != nil {
			prefix = "\x1eLAKE_DONE_" + job.marker + ":"
			at = strings.Index(l.pending, prefix)
		}
		if at >= 0 {
			end := strings.Index(l.pending[at+len(prefix):], "\x1f")
			if end < 0 {
				t.record(l, l.pending[:at])
				l.pending = l.pending[at:]
				break
			}
			end += at + len(prefix)
			t.record(l, l.pending[:at])
			status := l.pending[at+len(prefix) : end]
			l.pending = l.pending[end+1:]
			l.pending = strings.TrimPrefix(strings.TrimPrefix(l.pending, "\r"), "\n")
			var code any
			if regexp.MustCompile(`^\d{1,3}$`).MatchString(status) {
				var n int
				fmt.Sscanf(status, "%d", &n)
				if n <= 255 {
					code = n
				}
			}
			t.finish(l, code, "", false)
			continue
		}
		keep := 0
		if prefix != "" {
			for n := 1; n < len(prefix); n++ {
				if strings.HasSuffix(l.pending, prefix[:n]) {
					keep = n
				}
			}
		}
		if l.interactive && l.shell == "sh" {
			for n := 1; n < len(l.readyMarker); n++ {
				if strings.HasSuffix(l.pending, l.readyMarker[:n]) && n > keep {
					keep = n
				}
			}
		}
		t.record(l, l.pending[:len(l.pending)-keep])
		l.pending = l.pending[len(l.pending)-keep:]
		break
	}
	if l.flush == nil {
		interval := 100 * time.Millisecond
		if l.interactive {
			interval = 25 * time.Millisecond
		}
		l.flush = time.AfterFunc(interval, func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.flush = nil
			if !l.closed {
				t.flush(l)
			}
		})
	}
}
func (t *Terminals) flush(l *liveTerminal) {
	eid, output := "", ""
	if l.job != nil {
		eid = stringOf(l.job.entry["id"])
		output = t.redact(l.job.output)
	}
	t.store.OutputAt(l.session, l.id, eid, t.redact(l.output), output, l.capturedAt)
}
func (t *Terminals) finish(l *liveTerminal, code any, note string, disconnected bool) {
	job := l.job
	if job == nil {
		return
	}
	if job.timer != nil {
		job.timer.Stop()
	}
	l.job = nil
	if job.changed {
		code = nil
	}
	t.store.Finish(l.session, l.id, stringOf(job.entry["id"]), t.redact(job.output+note), code, disconnected, job.actionID)
	close(job.done)
	t.mu.Lock()
	delete(t.jobs, stringOf(job.entry["id"]))
	t.mu.Unlock()
	if !disconnected {
		t.flush(l)
	}
}
func (t *Terminals) Execute(id, tid, actor, command, actionID string) Object {
	origin := id
	if t.ResolveAccess != nil {
		id = t.ResolveAccess(id, tid, true)
	}
	if !validCommand(command) {
		fail(400, "command must be one nonempty line (max 2000 characters)")
	}
	if t.containsCredential(command) || strings.Contains(command, "-----BEGIN") {
		fail(400, "Commands must not contain credentials")
	}
	l := t.get(id, tid)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || !l.ready {
		fail(409, "Terminal disconnected")
	}
	entry := t.store.BeginCommand(id, tid, actor, command, actionID, origin)
	l.inputSeen = true
	job := &terminalJob{entry: entry, marker: ident(), done: make(chan struct{}), actionID: actionID}
	l.job = job
	if l.interactive && actor == "agent" {
		l.hiddenAgentOutput = true
		job.startMarker = "\x1eLAKE_START_" + job.marker + "\x1f"
	} else {
		l.hiddenAgentOutput = false
	}
	// Job lifetime belongs to the terminal, not any AI waiter.
	t.mu.Lock()
	t.jobs[stringOf(entry["id"])] = job
	t.mu.Unlock()
	if !l.hiddenAgentOutput {
		l.output = tail(l.output+"\r\n"+actor+" > "+command+"\r\n", outputLimit)
	}
	p := CommandPolicy(command)
	executable := command
	if p.Risk == "readonly" {
		executable = p.Safe
		if l.shell == "fish" {
			// Fish has no POSIX `command -p`. Run the already validated
			// read-only form with the system Shell in this terminal's cwd.
			executable = "command /bin/sh -c " + quote(p.Safe)
		}
	}
	_, err := l.pty.WriteString(commandFrame(l, executable, job.marker))
	if err != nil {
		go t.closeLive(l, "Failed to send command; outcome unknown")
	}
	t.flush(l)
	return entry
}
func (t *Terminals) Wait(ctx context.Context, id, tid, eid string) Object {
	if t.ResolveAccess != nil {
		id = t.ResolveAccess(id, tid, false)
	}
	t.store.Terminal(id, tid)
	// Validate the command's terminal before observing a global job completion channel.
	t.store.Entry(id, tid, eid)
	t.mu.Lock()
	job := t.jobs[eid]
	t.mu.Unlock()
	if job != nil {
		select {
		case <-ctx.Done():
			fail(409, "Wait cancelled; command continues in terminal")
		case <-job.done:
		}
	}
	return t.store.Entry(id, tid, eid)
}
func (t *Terminals) Control(id, tid string, holder any) Object {
	if t.ResolveAccess != nil {
		id = t.ResolveAccess(id, tid, false)
	}
	l := t.get(id, tid)
	l.mu.Lock()
	defer l.mu.Unlock()
	term := t.store.Control(id, tid, holder)
	if t.OnControl != nil {
		t.OnControl(tid, holder)
	}
	if holder == "user" && l.job != nil && l.job.entry["actor"] == "agent" {
		l.job.changed = true
		t.store.AddMessage(id, "system", "你已接管终端；Agent 不会再发送输入。当前命令仍在运行，其结果需核查。", nil)
	}
	return term
}
func (t *Terminals) Input(id, tid, data string, agent bool) {
	origin := id
	if t.ResolveAccess != nil {
		id = t.ResolveAccess(id, tid, true)
	}
	if data == "" || len(data) > 4096 || strings.ContainsRune(data, 0) || t.containsCredential(data) {
		fail(400, "Invalid terminal input")
	}
	l := t.get(id, tid)
	l.mu.Lock()
	defer l.mu.Unlock()
	term := t.store.Terminal(id, tid)
	if l.closed {
		fail(409, "Terminal disconnected")
	}
	if agent {
		if term["holder"] != "agent" || (term["status"] != "ready" && term["status"] != "busy") {
			fail(409, "Terminal is not owned by Agent")
		}
		if l.interactive {
			l.hiddenAgentOutput = true
		}
		if l.job == nil {
			l.rawOrigin = origin
		}
		t.store.TerminalStatus(id, tid, "busy")
	} else {
		if term["holder"] != "user" || (term["status"] != "busy" && !(l.interactive && term["status"] == "ready")) {
			fail(409, "Interactive input requires a running command and user ownership")
		}
		if l.job != nil && l.job.entry["actor"] == "agent" {
			l.job.changed = true
		}
		if l.interactive {
			if l.job == nil || l.job.entry["actor"] != "agent" {
				l.hiddenAgentOutput = false
			}
			l.userInputPending = !strings.Contains(data, "\x03") && !strings.Contains(data, "\x15")
		}
		if l.interactive && l.shell == "sh" && l.job == nil && strings.ContainsAny(data, "\r\n") {
			l.rawUserPending = true
			t.store.TerminalStatus(id, tid, "busy")
		}
	}
	_, e := l.pty.WriteString(data)
	l.inputSeen = true
	must(e)
}
func (t *Terminals) Resize(id, tid string, cols, rows int) {
	if t.ResolveAccess != nil {
		id = t.ResolveAccess(id, tid, false)
	}
	if cols < 20 || cols > 300 || rows < 5 || rows > 150 {
		fail(400, "Invalid terminal dimensions")
	}
	l := t.get(id, tid)
	l.mu.Lock()
	defer l.mu.Unlock()
	currentCols, currentRows := l.screen.Size()
	if cols == currentCols && rows == currentRows {
		return
	}
	must(resizeTerminal(l.pty, cols, rows))
	l.screen.Resize(cols, rows)
	if l.interactive && l.promptRedraw && !l.inputSeen {
		// The first browser fit can reflow the initial 100-column prompt before
		// the shell learns its actual size. Redraw the untouched prompt to remove
		// wrapped leftovers. Real input permanently disables this startup fix.
		_, err := l.pty.WriteString("\x0c")
		must(err)
	}
}
func (t *Terminals) Screen(id, tid, mode string, lines, maxChars int) string {
	return stringOf(t.ScreenResult(id, tid, mode, lines, maxChars)["text"])
}
func (t *Terminals) screenLocked(l *liveTerminal, mode string, lines, maxChars int) string {
	cols, rows := l.screen.Size()
	end := rows
	if mode == "cursor_before" {
		end = l.screen.Cursor().Y + 1
	}
	screen := []string{}
	if mode != "viewport" && l.screen.Mode()&vt10x.ModeAltScreen == 0 {
		screen = append(screen, l.scrollback...)
	}
	for y := 0; y < end; y++ {
		var row strings.Builder
		for x := 0; x < cols; x++ {
			c := l.screen.Cell(x, y).Char
			if c == 0 {
				c = ' '
			}
			row.WriteRune(c)
		}
		screen = append(screen, strings.TrimRight(row.String(), " "))
	}
	if mode == "tail" {
		for len(screen) > 0 && screen[len(screen)-1] == "" {
			screen = screen[:len(screen)-1]
		}
	}
	if lines < 1 {
		lines = 80
	}
	if lines > 1000 {
		lines = 1000
	}
	if mode != "viewport" && len(screen) > lines {
		screen = screen[len(screen)-lines:]
	}
	return tail(t.redact(strings.Join(screen, "\n")), maxChars)
}
func (t *Terminals) Interrupt(id, tid string) {
	if t.ResolveAccess != nil {
		id = t.ResolveAccess(id, tid, true)
	}
	l := t.get(id, tid)
	term := t.store.Terminal(id, tid)
	if term["status"] != "busy" {
		fail(409, "No running command in this terminal")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		fail(409, "Terminal disconnected")
	}
	if l.job != nil {
		l.job.changed = true
		job := l.job
		_, e := l.pty.WriteString("\x03")
		must(e)
		time.AfterFunc(100*time.Millisecond, func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			if !l.closed && l.job == job {
				_, _ = l.pty.WriteString("\x03")
			}
		})
		// The TTY flushes queued input on SIGINT. Send the recovery observation later.
		time.AfterFunc(250*time.Millisecond, func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			if !l.closed && l.job == job {
				_, _ = l.pty.WriteString("\nprintf '\\036LAKE_DONE_" + job.marker + ":unknown\\037\\n'\n")
			}
		})
	} else {
		_, e := l.pty.WriteString("\x03")
		must(e)
	}
}
func (t *Terminals) Close(id, tid string) {
	if t.ResolveAccess != nil {
		id = t.ResolveAccess(id, tid, true)
	}
	t.closeOwned(id, tid)
}

// Only explicit user HTTP closure and shutdown bypass an Agent writer lease.
func (t *Terminals) closeOwned(id, tid string) {
	t.store.Terminal(id, tid)
	t.mu.Lock()
	l := t.live[tid]
	t.mu.Unlock()
	if l != nil {
		t.closeLive(l, "Disconnected; outcome unknown")
	} else {
		t.store.TerminalStatus(id, tid, "disconnected")
	}
}
func (t *Terminals) closeLive(l *liveTerminal, reason string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return
	}
	l.closed = true
	if t.OnClose != nil {
		t.OnClose(l.id)
	}
	if l.startup != nil {
		l.startup.Stop()
	}
	if l.flush != nil {
		l.flush.Stop()
	}
	t.record(l, l.pending)
	l.pending = ""
	if !l.ready && retainedSSHCauses[l.startupCause] {
		t.record(l, "\r\n"+sshStartupHistoryPrefix+l.startupCause+"\r\n")
	}
	t.flush(l)
	t.finish(l, nil, "\n["+reason+"]", true)
	t.store.TerminalStatus(l.session, l.id, "disconnected")
	if !l.ready {
		startupOutput := l.output
		if l.screen != nil {
			startupOutput += "\n" + t.screenLocked(l, "tail", 1000, outputLimit)
		}
		message := terminalConnectionError(startupOutput, reason)
		if l.startupCause != "" && !strings.Contains(message, "凭据助手") {
			message = l.startupCause
		}
		message = terminalConnectionCauseWithExit(message, reason, l.startupExitCode)
		if l.connectionTarget != "" {
			message += " 连接目标：" + l.connectionTarget + "。"
		}
		l.connectErr = fmt.Errorf("%s", message)
		close(l.connected)
	}
	t.mu.Lock()
	delete(t.live, l.id)
	t.mu.Unlock()
	killForeground(l)
	l.pty.Close()
	if l.cmd.Process != nil {
		killTerminal(l.cmd.Process.Pid)
	}
}

func (t *Terminals) CloseSession(id string) {
	t.mu.Lock()
	a := []*liveTerminal{}
	for _, l := range t.live {
		if l.session == id {
			a = append(a, l)
		}
	}
	t.mu.Unlock()
	for _, l := range a {
		t.closeLive(l, "Session closed")
	}
}
func (t *Terminals) Shutdown() {
	t.mu.Lock()
	t.closing = true
	a := []*liveTerminal{}
	for _, l := range t.live {
		a = append(a, l)
	}
	t.mu.Unlock()
	for _, l := range a {
		t.closeLive(l, "Service stopped; outcome unknown")
	}
	t.wg.Wait()
}

func (t *Terminals) containsCredential(s string) bool {
	if strings.Contains(s, "-----BEGIN") {
		return true
	}
	secrets := t.authenticationSecrets()
	if model := t.models.Active(); model != nil {
		secrets = append(secrets, model.Key)
	}
	for _, secret := range secrets {
		if len(secret) > 0 && strings.Contains(s, secret) {
			return true
		}
	}
	return false
}

func (t *Terminals) authenticationSecrets() []string {
	secrets := []string{t.token, os.Getenv("LAKE_WEB_MODEL_KEY")}
	t.secretMu.RLock()
	defer t.secretMu.RUnlock()
	for secret := range t.authSecrets {
		secrets = append(secrets, secret)
	}
	return secrets
}
