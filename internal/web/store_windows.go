//go:build windows

package web

import (
	"database/sql"
	"golang.org/x/sys/windows"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
)

func lockStore(f *os.File) error {
	return windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
}
func unlockStore(f *os.File) error {
	return windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &windows.Overlapped{})
}
func openSQLite(path string) (*sql.DB, error) {
	return sql.Open("sqlite", filepath.ToSlash(path)+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
}
