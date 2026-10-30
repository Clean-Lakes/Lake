//go:build windows

package platform

import (
	"golang.org/x/sys/windows"
	"os"
)

func LockOwner(f *os.File) error {
	return windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
}

func ProcessRunning(pid int) (bool, error) {
	process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err == windows.ERROR_INVALID_PARAMETER {
		return false, nil
	}
	if err == windows.ERROR_ACCESS_DENIED {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(process)
	status, err := windows.WaitForSingleObject(process, 0)
	return status == uint32(windows.WAIT_TIMEOUT), err
}
