//go:build !windows

package platform

import (
	"golang.org/x/sys/unix"
	"os"
)

// LockOwner holds an OS lock until f is closed. Never unlink a locked file:
// doing so would allow a second process to lock a different inode at that path.
func LockOwner(f *os.File) error { return unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB) }

// ProcessRunning is conservative for permission-denied/reused PID records.
// Callers must never delete a live process's runtime metadata automatically.
func ProcessRunning(pid int) (bool, error) {
	err := unix.Kill(pid, 0)
	if err == nil || err == unix.EPERM {
		return true, nil
	}
	if err == unix.ESRCH {
		return false, nil
	}
	return false, err
}
