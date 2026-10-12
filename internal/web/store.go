package web

import (
	"crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	_ "github.com/mattn/go-sqlite3"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Object = map[string]any
type Failure struct {
	Status  int
	Message string
}

func (f *Failure) Error() string      { return f.Message }
func fail(status int, message string) { panic(&Failure{status, message}) }
func must(err error) {
	if err != nil {
		panic(err)
	}
}
func ident() string         { var b [16]byte; mustRand(b[:]); return hex.EncodeToString(b[:]) }
func mustRand(b []byte)     { _, e := rand.Read(b); must(e) }
func now() string           { return time.Now().UTC().Format(time.RFC3339Nano) }
func stringOf(v any) string { s, _ := v.(string); return s }
func integer(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	}
	return 0
}
func jsonText(v any) string { b, e := json.Marshal(v); must(e); return string(b) }
func object(v any) Object {
	o, _ := v.(map[string]any)
	if o == nil {
		return Object{}
	}
	return o
}
func objects(v any) []Object {
	if a, ok := v.([]Object); ok {
		return a
	}
	a, _ := v.([]any)
	out := []Object{}
	for _, v := range a {
		out = append(out, object(v))
	}
	return out
}
func stringsOf(v any) []string {
	if a, ok := v.([]string); ok {
		return a
	}
	a, _ := v.([]any)
	out := []string{}
	for _, v := range a {
		out = append(out, stringOf(v))
	}
	return out
}
func parsed(s string) any { var v any; must(json.Unmarshal([]byte(s), &v)); return v }

//go:embed schema.sql
var schema string

type queryer interface {
	Query(string, ...any) (*sql.Rows, error)
	Exec(string, ...any) (sql.Result, error)
}
type Store struct {
	mu          sync.Mutex
	db          *sql.DB
	q           queryer
	events      []Object
	subscribers map[chan Object]bool
	Dir         string
	lockFile    *os.File
}

func OpenStore(dir string) (*Store, error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	if e := os.Chmod(dir, 0700); e != nil {
		return nil, e
	}
	path := filepath.Join(dir, "lake-web.sqlite")
	lockFile, e := os.OpenFile(filepath.Join(dir, "server.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		lockFile.Close()
		return nil, fmt.Errorf("Lake data directory is already used by a Go backend")
	}
	opened := false
	defer func() {
		if !opened {
			syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
			lockFile.Close()
		}
	}()
	db, e := sql.Open("sqlite3", (&url.URL{Scheme: "file", Path: path}).String()+"?_foreign_keys=on&_busy_timeout=5000&_journal_mode=WAL")
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db, q: db, subscribers: map[chan Object]bool{}, Dir: dir, lockFile: lockFile}
	if _, e = db.Exec(schema); e != nil {
		db.Close()
		return nil, e
	}
	os.Chmod(path, 0600)
	defer func() {
		for _, suffix := range []string{"-wal", "-shm"} {
			os.Chmod(path+suffix, 0600)
		}
	}()
	if e = s.migrate(); e != nil {
		db.Close()
		return nil, e
	}
	s.update(func() any {
		s.seedResourceTree()
		// Capture work that is unfinished NOW. Historical unknown outcomes must
		// not mark a completed session as interrupted on every subsequent boot.
		interrupted := s.rows("SELECT id FROM sessions WHERE status IN ('investigating','waiting_approval') OR id IN (SELECT sessionId FROM actions WHERE status='running') OR id IN (SELECT sessionId FROM terminals WHERE status='busy') OR id IN (SELECT sessionId FROM specialists WHERE status='working')")
		for _, t := range s.rows("SELECT sessionId FROM terminals WHERE status!='disconnected'") {
			s.event(stringOf(t["sessionId"]), "terminal")
		}
		s.exec("UPDATE terminals SET status='disconnected',holder=NULL WHERE status!='disconnected'")
		s.exec("UPDATE terminalEntries SET status='unknown' WHERE status='running'")
		for _, a := range s.rows("SELECT sessionId FROM actions WHERE status='running'") {
			s.event(stringOf(a["sessionId"]), "action")
		}
		s.exec("UPDATE actions SET status='unknown',updatedAt=? WHERE status='running'", now())
		for _, a := range s.rows("SELECT sessionId FROM specialists WHERE status='working'") {
			s.event(stringOf(a["sessionId"]), "specialist")
		}
		s.exec("UPDATE specialists SET status='failed',summary='Investigation interrupted by server restart',finishedAt=? WHERE status='working'", now())
		for _, a := range interrupted {
			id := stringOf(a["id"])
			s.status(id, "failed")
			s.message(id, "system", "服务重启导致本次工作被中断。正在执行的命令结果未知；请先核对实际状态，再决定是否重试。", nil)
		}
		return nil
	})
	opened = true
	return s, nil
}
func (s *Store) migrate() error {
	needBackup := s.row("SELECT name FROM sqlite_master WHERE name='aiScopes'") == nil
	parityColumns := [][3]string{{"terminals", "generation", "TEXT NOT NULL DEFAULT ''"}, {"terminals", "outputCapturedAt", "TEXT"}, {"terminals", "cwd", "TEXT"}, {"terminals", "shell", "TEXT NOT NULL DEFAULT 'sh'"}, {"terminalEntries", "status", "TEXT NOT NULL DEFAULT 'unknown'"}, {"terminalEntries", "generation", "TEXT NOT NULL DEFAULT ''"}, {"terminalEntries", "cwd", "TEXT"}, {"terminalEntries", "startedAt", "TEXT"}, {"terminalEntries", "finishedAt", "TEXT"}, {"terminalEntries", "originSessionId", "TEXT"}}
	for _, c := range parityColumns {
		found := false
		for _, row := range s.rows("PRAGMA table_info(" + c[0] + ")") {
			found = found || row["name"] == c[1]
		}
		if !found {
			needBackup = true
		}
	}
	for _, item := range [][2]string{{"messages", "images"}, {"actions", "terminalId"}, {"actions", "contextVersion"}, {"terminals", "contextVersion"}, {"terminals", "output"}} {
		found := false
		for _, r := range s.rows("PRAGMA table_info(" + item[0] + ")") {
			if r["name"] == item[1] {
				found = true
			}
		}
		if !found {
			needBackup = true
		}
	}
	for _, table := range []string{"resources", "terminals"} {
		sql := stringOf(s.row("SELECT sql FROM sqlite_master WHERE name=?", table)["sql"])
		if strings.Contains(sql, "CHECK(kind = 'local')") || strings.Contains(sql, "CHECK(kind IN ('local','ssh'))") || strings.Contains(sql, "CHECK(status IN ('ready','busy','disconnected','unknown'))") {
			needBackup = true
		}
	}
	if needBackup {
		backup := filepath.Join(s.Dir, "lake-web.before-go-"+ident()+".sqlite")
		if _, e := s.db.Exec("VACUUM INTO ?", backup); e != nil {
			return e
		}
		if e := os.Chmod(backup, 0600); e != nil {
			return e
		}
	}
	if _, err := s.db.Exec("CREATE TABLE IF NOT EXISTS aiScopes(scope TEXT NOT NULL,projectId TEXT NOT NULL REFERENCES projects(id),resourceKind TEXT NOT NULL,resourceId TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,sessionId TEXT UNIQUE NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,PRIMARY KEY(scope,projectId,resourceKind,resourceId))"); err != nil {
		return err
	}
	for _, c := range append(parityColumns, [][3]string{{"messages", "images", "TEXT NOT NULL DEFAULT '[]'"}, {"actions", "terminalId", "TEXT"}, {"actions", "contextVersion", "INTEGER"}, {"terminals", "contextVersion", "INTEGER NOT NULL DEFAULT 0"}, {"terminals", "output", "TEXT NOT NULL DEFAULT ''"}}...) {
		found := false
		for _, r := range s.rows("PRAGMA table_info(" + c[0] + ")") {
			if r["name"] == c[1] {
				found = true
			}
		}
		if !found {
			if _, e := s.db.Exec("ALTER TABLE " + c[0] + " ADD COLUMN " + c[1] + " " + c[2]); e != nil {
				return e
			}
		}
	}
	if _, err := s.db.Exec("UPDATE terminalEntries SET status='completed' WHERE status='unknown' AND exitCode IS NOT NULL"); err != nil {
		return err
	}
	for _, table := range []string{"resources", "terminals"} {
		old := stringOf(s.row("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table)["sql"])
		next := old
		if table == "resources" {
			for _, v := range []string{"CHECK(kind = 'local')", "CHECK(kind IN ('local','ssh'))"} {
				next = strings.ReplaceAll(next, v, "CHECK(kind IN ('local','ssh','database','docker','redis'))")
			}
		} else {
			next = strings.ReplaceAll(next, "CHECK(status IN ('ready','busy','disconnected','unknown'))", "CHECK(status IN ('connecting','ready','busy','disconnected','unknown'))")
		}
		if next == old {
			continue
		}
		if _, e := s.db.Exec("PRAGMA foreign_keys=OFF"); e != nil {
			return e
		}
		tx, e := s.db.Begin()
		if e != nil {
			return e
		}
		next = strings.Replace(next, "CREATE TABLE "+table, "CREATE TABLE "+table+"_next", 1)
		next = strings.Replace(next, "CREATE TABLE \""+table+"\"", "CREATE TABLE "+table+"_next", 1)
		for _, query := range []string{next, "INSERT INTO " + table + "_next SELECT * FROM " + table, "DROP TABLE " + table, "ALTER TABLE " + table + "_next RENAME TO " + table} {
			if _, e = tx.Exec(query); e != nil {
				tx.Rollback()
				s.db.Exec("PRAGMA foreign_keys=ON")
				return e
			}
		}
		if e = tx.Commit(); e != nil {
			return e
		}
		s.db.Exec("PRAGMA foreign_keys=ON")
	}
	_, e := s.db.Exec("CREATE INDEX IF NOT EXISTS idx_terminals_session ON terminals(sessionId,createdAt); CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(projectId)")
	return e
}
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.subscribers {
		close(ch)
		delete(s.subscribers, ch)
	}
	err := s.db.Close()
	if s.lockFile != nil {
		syscall.Flock(int(s.lockFile.Fd()), syscall.LOCK_UN)
		s.lockFile.Close()
	}
	return err
}
func (s *Store) read(work func() any) any { s.mu.Lock(); defer s.mu.Unlock(); return work() }
func (s *Store) update(work func() any) (result any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.db.Begin()
	must(e)
	s.q = tx
	s.events = nil
	defer func() {
		s.q = s.db
		s.events = nil
		if p := recover(); p != nil {
			tx.Rollback()
			panic(p)
		}
	}()
	result = work()
	must(tx.Commit())
	for _, ev := range s.events {
		for ch := range s.subscribers {
			select {
			case ch <- ev:
			default:
				close(ch)
				delete(s.subscribers, ch)
			}
		}
	}
	return
}
func (s *Store) exec(query string, args ...any) sql.Result {
	r, e := s.q.Exec(query, args...)
	must(e)
	return r
}
func (s *Store) rows(query string, args ...any) []Object {
	rows, e := s.q.Query(query, args...)
	must(e)
	defer rows.Close()
	cols, e := rows.Columns()
	must(e)
	out := []Object{}
	for rows.Next() {
		values := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range ptrs {
			ptrs[i] = &values[i]
		}
		must(rows.Scan(ptrs...))
		r := Object{}
		for i, k := range cols {
			v := values[i]
			if b, ok := v.([]byte); ok {
				v = string(b)
			}
			r[k] = v
		}
		out = append(out, r)
	}
	must(rows.Err())
	return out
}
func (s *Store) row(query string, args ...any) Object {
	a := s.rows(query, args...)
	if len(a) == 0 {
		return nil
	}
	return a[0]
}
func required(o Object, name string) Object {
	if o == nil {
		fail(404, name+" not found")
	}
	return o
}
func (s *Store) event(id, kind string) {
	t := now()
	r := s.exec("INSERT INTO events(sessionId,type,createdAt) VALUES(?,?,?)", id, kind, t)
	n, e := r.LastInsertId()
	must(e)
	s.events = append(s.events, Object{"seq": n, "sessionId": id, "type": kind, "createdAt": t})
}
func (s *Store) Subscribe() (chan Object, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := make(chan Object, 128)
	s.subscribers[ch] = true
	return ch, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.subscribers[ch] {
			delete(s.subscribers, ch)
			close(ch)
		}
	}
}
func (s *Store) Touch(id string) {
	s.update(func() any { s.session(id); s.event(id, "message"); return nil })
}
func (s *Store) Events(id string, after int64) []Object {
	return s.read(func() any {
		s.session(id)
		return s.rows("SELECT * FROM events WHERE sessionId=? AND seq>? ORDER BY seq LIMIT 1000", id, after)
	}).([]Object)
}
func (s *Store) resource(id string) Object {
	r := required(s.row("SELECT * FROM resources WHERE id=?", id), "Resource")
	if c := s.row("SELECT config FROM resourceConnections WHERE resourceId=?", id); c != nil {
		key := "settings"
		if r["kind"] == "ssh" {
			key = "ssh"
		}
		r[key] = parsed(stringOf(c["config"]))
	}
	return r
}
func (s *Store) Resource(id string) Object {
	return s.read(func() any { return s.resource(id) }).(Object)
}
func (s *Store) session(id string) Object {
	r := required(s.row("SELECT * FROM sessions WHERE id=?", id), "Session")
	ids := []string{}
	// Resource availability follows the project, including resources added after
	// this session was created. Legacy sessionResources rows remain historical.
	for _, v := range s.rows("SELECT id FROM resources WHERE projectId=? ORDER BY rowid", r["projectId"]) {
		ids = append(ids, stringOf(v["id"]))
	}
	r["resourceIds"] = ids
	return r
}
func (s *Store) Session(id string) Object {
	return s.read(func() any { return s.session(id) }).(Object)
}
func (s *Store) assertResource(id, ref string) {
	session := s.session(id)
	if s.row("SELECT 1 FROM resources WHERE projectId=? AND id=?", session["projectId"], ref) == nil {
		fail(404, "Resource not found in session project")
	}
}
func (s *Store) AssertResource(id, ref string) {
	s.read(func() any { s.assertResource(id, ref); return nil })
}
func (s *Store) Catalog() Object {
	return s.read(func() any {
		resources := []Object{}
		for _, r := range s.rows("SELECT id FROM resources ORDER BY rowid") {
			resources = append(resources, s.resource(stringOf(r["id"])))
		}
		sessions := []Object{}
		for _, r := range s.rows("SELECT id FROM sessions WHERE NOT EXISTS (SELECT 1 FROM aiScopes a WHERE a.sessionId=sessions.id AND (a.scope='resource-terminal' OR (a.scope='enhanced-terminal' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.sessionId=sessions.id)))) ORDER BY createdAt DESC,rowid DESC") {
			sessions = append(sessions, s.session(stringOf(r["id"])))
		}
		return Object{"projects": s.rows("SELECT * FROM projects ORDER BY createdAt,id"), "resources": resources, "resourceTree": s.rows("SELECT * FROM resourceTree ORDER BY position,id"), "sessions": sessions, "terminals": s.rows("SELECT t.id,t.sessionId,t.resourceId,t.status,t.holder,t.contextVersion,t.createdAt,s.title AS sessionTitle FROM terminals t JOIN sessions s ON s.id=t.sessionId WHERE t.status!='disconnected' ORDER BY t.createdAt,t.rowid")}
	}).(Object)
}
func (s *Store) Project(id string) Object {
	return s.read(func() any { return required(s.row("SELECT * FROM projects WHERE id=?", id), "Project") }).(Object)
}
func (s *Store) CreateProject(name string) Object {
	return s.update(func() any {
		p := Object{"id": ident(), "name": name, "createdAt": now()}
		s.exec("INSERT INTO projects(id,name,createdAt) VALUES(?,?,?)", p["id"], name, p["createdAt"])
		s.exec("INSERT INTO resources(id,projectId,name,kind,description,status) VALUES(?,?,?,?,?,?)", ident(), p["id"], "Local machine", "local", "This server's local command terminal (no remote host connection)", "available")
		s.seedResourceTree()
		return p
	}).(Object)
}
func (s *Store) CreateResource(project, name, kind string, config Object) Object {
	return s.update(func() any {
		required(s.row("SELECT id FROM projects WHERE id=?", project), "Project")
		if ref := stringOf(config["ssh_asset_ref"]); ref != "" {
			r := s.resource(ref)
			if r["projectId"] != project || r["kind"] != "ssh" {
				fail(400, "Associated SSH resource must belong to this project")
			}
		}
		description := kind
		for _, key := range []string{"host", "path", "endpoint"} {
			if stringOf(config[key]) != "" {
				description = stringOf(config[key])
				break
			}
		}
		if kind == "ssh" {
			description = fmt.Sprintf("%s@%s:%d", config["username"], config["host"], integer(config["port"]))
		}
		id := ident()
		s.exec("INSERT INTO resources(id,projectId,name,kind,description,status) VALUES(?,?,?,?,?,?)", id, project, name, kind, description, "available")
		s.exec("INSERT INTO resourceConnections(resourceId,config) VALUES(?,?)", id, jsonText(config))
		s.seedResourceTree()
		for _, session := range s.rows("SELECT id FROM sessions WHERE projectId=?", project) {
			s.event(stringOf(session["id"]), "session")
		}
		return s.resource(id)
	}).(Object)
}
func (s *Store) CreateSession(project, title string, chosen []string) Object {
	return s.update(func() any {
		required(s.row("SELECT id FROM projects WHERE id=?", project), "Project")
		available := map[string]bool{}
		for _, r := range s.rows("SELECT id FROM resources WHERE projectId=? ORDER BY rowid", project) {
			available[stringOf(r["id"])] = true
		}
		// Accept resourceIds from older clients, but they no longer limit the
		// session. Validate them so a cross-project ID is never accepted.
		seen := map[string]bool{}
		for _, id := range chosen {
			if !available[id] || seen[id] {
				fail(400, "resourceIds must contain distinct resources in the project")
			}
			seen[id] = true
		}
		automaticTitle := strings.TrimSpace(title) == ""
		if automaticTitle {
			title = "新会话"
		}
		id, t := ident(), now()
		s.exec("INSERT INTO sessions(id,projectId,title,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?)", id, project, title, "idle", t, t)
		if automaticTitle {
			s.exec("INSERT INTO sessionNaming(sessionId) VALUES(?)", id)
		}
		for _, ref := range chosen {
			s.exec("INSERT INTO sessionResources(sessionId,resourceId) VALUES(?,?)", id, ref)
		}
		s.event(id, "session")
		return s.session(id)
	}).(Object)
}
func (s *Store) DeleteSession(id string) {
	s.update(func() any {
		s.session(id)
		s.exec("UPDATE terminalEntries SET actionId=NULL WHERE actionId IN (SELECT id FROM actions WHERE sessionId=?)", id)
		s.exec("DELETE FROM terminalEntries WHERE terminalId IN (SELECT id FROM terminals WHERE sessionId=?)", id)
		for _, table := range []string{"aiOptions", "events", "evidence", "specialists", "actions", "terminals", "messages", "sessionResources"} {
			s.exec("DELETE FROM "+table+" WHERE sessionId=?", id)
		}
		s.exec("DELETE FROM sessions WHERE id=?", id)
		return nil
	})
}
func (s *Store) snapshot(id string) Object {
	session := s.session(id)
	resources := []Object{}
	for _, ref := range stringsOf(session["resourceIds"]) {
		resources = append(resources, s.resource(ref))
	}
	messages := s.rows("SELECT * FROM messages WHERE sessionId=? ORDER BY createdAt,rowid", id)
	for _, m := range messages {
		images := objects(parsed(stringOf(m["images"])))
		delete(m, "images")
		if len(images) > 0 {
			for _, im := range images {
				im["base64"] = ""
				im["url"] = "/api/sessions/" + id + "/messages/" + stringOf(m["id"]) + "/images/" + stringOf(im["id"])
			}
			m["images"] = images
		}
	}
	actions := s.rows("SELECT * FROM actions WHERE sessionId=? ORDER BY createdAt,rowid", id)
	for _, a := range actions {
		p := CommandPolicy(stringOf(a["command"]))
		a["risk"] = p.Risk
		a["riskReason"] = p.Reason
	}
	return Object{"session": session, "resources": resources, "resourceTree": s.rows("SELECT * FROM resourceTree WHERE projectId=? ORDER BY position,id", session["projectId"]), "messages": messages, "actions": actions, "specialists": s.rows("SELECT * FROM specialists WHERE sessionId=? ORDER BY createdAt,rowid", id), "evidence": s.rows("SELECT * FROM evidence WHERE sessionId=? ORDER BY collectedAt,rowid", id), "terminals": s.rows("SELECT id,sessionId,resourceId,status,holder,contextVersion,createdAt,generation,outputCapturedAt,cwd,shell FROM terminals WHERE sessionId=? ORDER BY createdAt,rowid", id), "cursor": s.row("SELECT COALESCE(MAX(seq),0) AS cursor FROM events WHERE sessionId=?", id)["cursor"]}
}
func (s *Store) Snapshot(id string) Object {
	return s.read(func() any { return s.snapshot(id) }).(Object)
}
func (s *Store) Image(id, mid, iid string) Object {
	return s.read(func() any {
		s.session(id)
		row := required(s.row("SELECT images FROM messages WHERE id=? AND sessionId=?", mid, id), "Message")
		for _, im := range objects(parsed(stringOf(row["images"]))) {
			if im["id"] == iid {
				return im
			}
		}
		fail(404, "Image not found")
		return nil
	}).(Object)
}
func (s *Store) Options(id string) Object {
	return s.read(func() any {
		s.session(id)
		r := s.row("SELECT value FROM aiOptions WHERE sessionId=?", id)
		if r == nil {
			return Object{}
		}
		return object(parsed(stringOf(r["value"])))
	}).(Object)
}
func (s *Store) SaveOptions(id string, o Object) {
	s.update(func() any {
		s.session(id)
		s.exec("INSERT INTO aiOptions(sessionId,value) VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET value=excluded.value", id, jsonText(o))
		s.event(id, "message")
		return nil
	})
}
func (s *Store) message(id, role, text string, images any) Object {
	s.session(id)
	if images == nil {
		images = []any{}
	}
	m := Object{"id": ident(), "sessionId": id, "role": role, "text": text, "createdAt": now()}
	s.exec("INSERT INTO messages(id,sessionId,role,text,images,createdAt) VALUES(?,?,?,?,?,?)", m["id"], id, role, text, jsonText(images), m["createdAt"])
	s.event(id, "message")
	if images != nil && len(objects(parsed(jsonText(images)))) > 0 {
		m["images"] = images
	}
	return m
}
func (s *Store) AddMessage(id, role, text string, images any) Object {
	return s.update(func() any { return s.message(id, role, text, images) }).(Object)
}
func (s *Store) Begin(id, text string, images any, titleInput ...string) Object {
	return s.update(func() any {
		r := s.session(id)
		if r["status"] == "investigating" {
			fail(409, "Investigation already running")
		}
		m := s.message(id, "user", text, images)
		if s.row("SELECT 1 FROM sessionNaming WHERE sessionId=? AND generated=0", id) != nil {
			input := text
			if len(titleInput) > 0 {
				input = titleInput[0]
			}
			if title := sessionTitle(input); title != "" {
				s.exec("UPDATE sessions SET title=? WHERE id=?", title, id)
				s.exec("UPDATE sessionNaming SET generated=1 WHERE sessionId=?", id)
				s.event(id, "session")
			}
		}
		s.status(id, "investigating")
		return m
	}).(Object)
}
func (s *Store) status(id, status string) {
	s.session(id)
	s.exec("UPDATE sessions SET status=?,updatedAt=? WHERE id=?", status, now(), id)
	s.event(id, "session")
}
func (s *Store) Status(id, status string) { s.update(func() any { s.status(id, status); return nil }) }
func (s *Store) terminal(id, tid string) Object {
	return required(s.row("SELECT id,sessionId,resourceId,status,holder,contextVersion,createdAt,generation,outputCapturedAt,cwd,shell FROM terminals WHERE id=? AND sessionId=?", tid, id), "Terminal")
}
func (s *Store) Terminal(id, tid string) Object {
	return s.read(func() any { return s.terminal(id, tid) }).(Object)
}

func (s *Store) ResourceTerminals(ref string) []Object {
	return s.read(func() any {
		s.resource(ref)
		return s.rows("SELECT id,sessionId,resourceId,status,holder,contextVersion,createdAt,generation,outputCapturedAt,cwd,shell FROM terminals WHERE resourceId=? AND status!='disconnected' ORDER BY createdAt,rowid", ref)
	}).([]Object)
}

func (s *Store) ResourceTerminal(ref, tid string) Object {
	return s.read(func() any {
		s.resource(ref)
		return required(s.row("SELECT id,sessionId,resourceId,status,holder,contextVersion,createdAt,generation,outputCapturedAt,cwd,shell FROM terminals WHERE id=? AND resourceId=?", tid, ref), "Resource terminal")
	}).(Object)
}
func (s *Store) CreateTerminal(id, ref string) Object {
	return s.update(func() any {
		s.assertResource(id, ref)
		tid := ident()
		s.exec("INSERT INTO terminals(id,sessionId,resourceId,status,holder,createdAt,generation) VALUES(?,?,?,?,?,?,?)", tid, id, ref, "connecting", "user", now(), ident())
		s.event(id, "terminal")
		return s.terminal(id, tid)
	}).(Object)
}
func (s *Store) TerminalStatus(id, tid, status string) {
	s.update(func() any {
		s.terminal(id, tid)
		if status == "disconnected" {
			s.exec("UPDATE terminals SET status=?,holder=NULL WHERE id=?", status, tid)
		} else {
			s.exec("UPDATE terminals SET status=? WHERE id=?", status, tid)
		}
		s.event(id, "terminal")
		return nil
	})
}
func (s *Store) Control(id, tid string, holder any) Object {
	return s.update(func() any {
		t := s.terminal(id, tid)
		if t["status"] != "ready" && !(holder == "user" && t["status"] == "busy") {
			fail(409, "Terminal is not ready")
		}
		s.exec("UPDATE terminals SET holder=? WHERE id=?", holder, tid)
		s.event(id, "terminal")
		return s.terminal(id, tid)
	}).(Object)
}
func (s *Store) History(id, tid string) Object {
	return s.read(func() any {
		t := s.terminal(id, tid)
		rows := s.rows("SELECT id,terminalId,actor,command,output,exitCode,createdAt,status,generation,cwd,startedAt,finishedAt,originSessionId FROM terminalEntries WHERE terminalId=? ORDER BY rowid DESC LIMIT 500", tid)
		for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
			rows[i], rows[j] = rows[j], rows[i]
		}
		return Object{"terminal": t, "entries": rows, "output": s.row("SELECT output FROM terminals WHERE id=?", tid)["output"]}
	}).(Object)
}
func (s *Store) Entry(id, tid, eid string) Object {
	return s.read(func() any {
		s.terminal(id, tid)
		return required(s.row("SELECT id,terminalId,actor,command,output,exitCode,createdAt,status,generation,cwd,startedAt,finishedAt,originSessionId FROM terminalEntries WHERE id=? AND terminalId=?", eid, tid), "Command")
	}).(Object)
}
func (s *Store) Recent(id string) []Object {
	return s.read(func() any {
		s.session(id)
		a := s.rows("SELECT e.*,t.resourceId FROM terminalEntries e JOIN terminals t ON t.id=e.terminalId WHERE t.sessionId=? AND e.exitCode IS NOT NULL ORDER BY e.rowid DESC LIMIT 8", id)
		for i, j := 0, len(a)-1; i < j; i, j = i+1, j-1 {
			a[i], a[j] = a[j], a[i]
		}
		return a
	}).([]Object)
}
func (s *Store) BeginCommand(id, tid, actor, command, actionID string, origins ...string) Object {
	origin := id
	if len(origins) > 0 {
		origin = origins[0]
	}
	return s.update(func() any {
		t := s.terminal(id, tid)
		if t["status"] != "ready" || t["holder"] != actor {
			fail(409, "Terminal busy or held by another actor")
		}
		if actor == "agent" {
			if actionID == "" {
				if CommandPolicy(command).Risk != "readonly" {
					fail(403, "This Agent command requires single-use approval")
				}
			} else {
				a := s.action(actionID)
				if a["sessionId"] != origin || a["resourceId"] != t["resourceId"] || a["command"] != command || a["status"] != "running" || (a["terminalId"] != nil && (a["terminalId"] != tid || integer(a["contextVersion"]) != integer(t["contextVersion"]))) || s.row("SELECT 1 FROM terminalEntries WHERE actionId=?", actionID) != nil {
					fail(403, "Command is not authorized by this approval")
				}
			}
		}
		eid := ident()
		var aid any
		if actionID != "" {
			aid = actionID
		}
		s.exec("INSERT INTO terminalEntries(id,terminalId,actor,command,output,exitCode,actionId,createdAt,status,generation,cwd,startedAt,originSessionId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", eid, tid, actor, command, "", nil, aid, now(), "running", t["generation"], t["cwd"], now(), origin)
		s.exec("UPDATE terminals SET status='busy',contextVersion=contextVersion+1 WHERE id=?", tid)
		s.event(id, "terminal")
		return s.row("SELECT id,terminalId,actor,command,output,exitCode,createdAt,status,generation,cwd,startedAt,finishedAt,originSessionId FROM terminalEntries WHERE id=?", eid)
	}).(Object)
}
func (s *Store) Output(id, tid, eid, output, jobOutput string) {
	s.OutputAt(id, tid, eid, output, jobOutput, now())
}
func (s *Store) OutputAt(id, tid, eid, output, jobOutput, captured string) {
	s.update(func() any {
		s.terminal(id, tid)
		s.exec("UPDATE terminals SET output=?,outputCapturedAt=? WHERE id=?", output, captured, tid)
		if eid != "" {
			s.exec("UPDATE terminalEntries SET output=? WHERE id=?", jobOutput, eid)
		}
		s.event(id, "terminal")
		return nil
	})
}
func (s *Store) Finish(id, tid, eid, output string, code any, disconnected bool, actionID string) {
	s.update(func() any {
		t := s.terminal(id, tid)
		s.exec("UPDATE terminalEntries SET output=?,exitCode=?,status=?,finishedAt=? WHERE id=? AND terminalId=?", output, code, map[bool]string{true: "completed", false: "unknown"}[code != nil], now(), eid, tid)
		status, holder := "ready", t["holder"]
		if disconnected {
			status = "disconnected"
			holder = nil
		}
		s.exec("UPDATE terminals SET status=?,holder=? WHERE id=?", status, holder, tid)
		s.event(id, "terminal")
		if actionID != "" {
			a := s.action(actionID)
			if a["status"] == "running" {
				result := "failed"
				if code == nil {
					result = "unknown"
				} else if integer(code) == 0 {
					result = "succeeded"
				}
				s.exec("UPDATE actions SET status=?,exitCode=?,updatedAt=? WHERE id=?", result, code, now(), actionID)
				s.event(stringOf(a["sessionId"]), "action")
			}
		}
		return nil
	})
}
func (s *Store) action(id string) Object {
	a := required(s.row("SELECT * FROM actions WHERE id=?", id), "Action")
	p := CommandPolicy(stringOf(a["command"]))
	a["risk"] = p.Risk
	a["riskReason"] = p.Reason
	return a
}
func (s *Store) Action(id string) Object { return s.read(func() any { return s.action(id) }).(Object) }
func (s *Store) AddAction(id, ref, tid, command, intent string, owners ...string) Object {
	owner := id
	if len(owners) > 0 {
		owner = owners[0]
	}
	return s.update(func() any {
		s.assertResource(id, ref)
		t := s.terminal(owner, tid)
		if t["resourceId"] != ref {
			fail(400, "Action target does not match terminal")
		}
		aid := ident()
		time := now()
		s.exec("INSERT INTO actions(id,sessionId,resourceId,command,reason,impact,verification,terminalId,contextVersion,status,exitCode,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", aid, id, ref, command, intent, "按已确认参数执行", "检查实际输出", tid, t["contextVersion"], "pending", nil, time, time)
		s.event(id, "action")
		return s.action(aid)
	}).(Object)
}
func (s *Store) Decide(aid, decision, confirmation string, internal bool) Object {
	return s.update(func() any {
		a := s.action(aid)
		if a["status"] != "pending" {
			fail(409, "Action already decided")
		}
		id := stringOf(a["sessionId"])
		if !internal && s.session(id)["status"] == "investigating" {
			fail(409, "Wait for the current reply before deciding")
		}
		if decision == "approve" && a["risk"] == "dangerous" && confirmation != "执行 "+stringOf(s.resource(stringOf(a["resourceId"]))["name"]) {
			fail(400, "Dangerous command requires explicit target confirmation")
		}
		status := "running"
		if decision == "reject" {
			status = "rejected"
		}
		s.exec("UPDATE actions SET status=?,updatedAt=? WHERE id=?", status, now(), aid)
		s.event(id, "action")
		if !internal {
			status = "investigating"
			if decision == "reject" {
				status = "completed"
			}
			s.status(id, status)
		}
		return s.action(aid)
	}).(Object)
}
func (s *Store) TerminalForAction(a Object) Object {
	return s.read(func() any {
		id, ref := stringOf(a["sessionId"]), stringOf(a["resourceId"])
		if tid := stringOf(a["terminalId"]); tid != "" {
			t := s.terminal(id, tid)
			if t["resourceId"] != ref || integer(t["contextVersion"]) != integer(a["contextVersion"]) {
				fail(409, "终端上下文已变化，请重新提出操作后审批")
			}
			if t["status"] == "ready" {
				return t
			}
			return Object{}
		}
		return object(s.row("SELECT id,sessionId,resourceId,status,holder,contextVersion,createdAt,generation,outputCapturedAt,cwd,shell FROM terminals WHERE sessionId=? AND resourceId=? AND status='ready' ORDER BY createdAt DESC LIMIT 1", id, ref))
	}).(Object)
}

func (s *Store) UnknownAction(id string) {
	s.update(func() any {
		a := s.action(id)
		if a["status"] == "running" {
			s.exec("UPDATE actions SET status='unknown',updatedAt=? WHERE id=?", now(), id)
			session := stringOf(a["sessionId"])
			s.event(session, "action")
			s.message(session, "system", "命令启动结果未知，请核对实际状态后再决定是否重试。", nil)
			s.status(session, "failed")
		}
		return nil
	})
}
