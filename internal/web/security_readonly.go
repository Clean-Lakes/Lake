package web

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/platform"
)

const recoveryReadOnlyMessage = "已恢复项目和历史记录的只读查看；安全迁移尚未完成，命令、模型调用、修改及后台任务暂不可执行"

func openRecoveryStore(dir string) (*Store, error) {
	path := filepath.Join(dir, "lake-web.sqlite")
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || !platform.Private(path, info) {
		return nil, errors.New("invalid recovery project database")
	}
	lock, err := platform.OpenFile(filepath.Join(dir, "server.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = lockStore(lock); err != nil {
		lock.Close()
		return nil, fmt.Errorf("Lake data directory is already used by a Go backend")
	}
	db, err := openSQLiteReadOnly(path)
	if err == nil {
		db.SetMaxOpenConns(1)
		err = db.Ping()
	}
	if err != nil {
		if db != nil {
			db.Close()
		}
		unlockStore(lock)
		lock.Close()
		return nil, err
	}
	// No normal Store constructor: it runs migrations and restart recovery.
	s := &Store{db: db, q: db, Dir: dir, lockFile: lock, subscribers: map[chan Object]bool{}, readOnly: true, memoryV2Wanted: operationalMemoryV2Ready}
	if err = s.checkMemoryV2Compatibility(); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

// This router is an explicit local-read allowlist. Even GET endpoints can call
// a provider, start an extension, or recover work, so none fall through to the
// normal API router. No Engine, Terminals, Extensions, or workers are created.
func (b *Server) serveRecoveryView(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		fail(409, recoveryReadOnlyMessage)
	}
	if r.URL.Path == "/api/catalog" {
		reply(w, 200, b.Store.Catalog())
		return
	}
	p := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(p) >= 4 && p[0] == "api" && p[1] == "sessions" {
		id := p[2]
		b.Store.Session(id)
		if len(p) == 4 {
			switch p[3] {
			case "snapshot":
				snapshot := b.Store.Snapshot(id)
				view, err := b.securityRuntime.RecoverySnapshot(id, 0, 100)
				aiFailure(err)
				snapshot["ai"] = view
				snapshot["sre"] = b.recoverySRESnapshot(id)
				snapshot["conversationMode"] = b.conversationMode(id)
				snapshot["recoveryReadOnly"] = true
				reply(w, 200, snapshot)
				return
			case "ai":
				view, err := b.securityRuntime.RecoverySnapshot(id, 0, 100)
				aiFailure(err)
				reply(w, 200, view)
				return
			case "message-queue":
				reply(w, 200, b.Store.MessageQueue(id))
				return
			case "events":
				after := r.URL.Query().Get("after")
				if after == "" {
					after = r.Header.Get("Last-Event-ID")
				}
				if after == "" {
					after = "0"
				}
				cursor, err := strconv.ParseInt(after, 10, 64)
				if err != nil || cursor < 0 || cursor > 9007199254740991 || strconv.FormatInt(cursor, 10) != after {
					fail(400, "after must be a nonnegative event cursor")
				}
				b.sse(w, r, id, cursor)
				return
			}
		}
		if len(p) == 5 && p[3] == "ai" {
			switch p[4] {
			case "snapshot":
				before, err := strconv.Atoi(defaultText(r.URL.Query().Get("before"), "0"))
				if err != nil || before < 0 {
					fail(400, "Invalid card cursor")
				}
				view, err := b.securityRuntime.RecoverySnapshot(id, before, 100)
				aiFailure(err)
				reply(w, 200, view)
				return
			case "options":
				reply(w, 200, b.Store.Options(id))
				return
			case "mode":
				reply(w, 200, Object{"mode": b.conversationMode(id)})
				return
			}
		}
	}
	fail(409, recoveryReadOnlyMessage)
}

func (b *Server) recoverySRESnapshot(id string) *ai.SRESnapshot {
	// ListSRETasks normally reconciles commands in a write transaction. Reading
	// the persisted bodies preserves unresolved attempts exactly as recorded.
	tasks := b.Store.read(func() any {
		out := []ai.SRETask{}
		for _, row := range b.Store.rows("SELECT body FROM sreTasks WHERE sessionId=? ORDER BY createdAt DESC,id DESC LIMIT 20", id) {
			out = append(out, decodeSRETask(row))
		}
		return out
	}).([]ai.SRETask)
	project := stringOf(b.Store.Session(id)["projectId"])
	settings := b.Store.PilotSettings(project)
	return &ai.SRESnapshot{FeatureVersion: 1, Enabled: settings["enabled"] == true, Tasks: tasks, Pilot: &ai.PilotSettings{Enabled: settings["enabled"] == true, AutoAdvance: settings["autoAdvance"] == true, Revision: integer(settings["revision"])}}
}
