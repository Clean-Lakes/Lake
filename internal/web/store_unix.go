//go:build !windows

package web

import (
	"database/sql"
	_ "github.com/mattn/go-sqlite3"
	"net/url"
	"os"
	"syscall"
)

func lockStore(f *os.File) error   { return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) }
func unlockStore(f *os.File) error { return syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }
func openSQLite(path string) (*sql.DB, error) {
	return sql.Open("sqlite3", (&url.URL{Scheme: "file", Path: path}).String()+"?_foreign_keys=on&_busy_timeout=5000&_journal_mode=WAL")
}
