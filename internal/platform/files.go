package platform

import (
	"os"
	"runtime"
)

// OpenFile applies a real private ACL to newly created Windows data files.
func OpenFile(path string, flags int, mode os.FileMode) (*os.File, error) {
	file, err := os.OpenFile(path, flags, mode)
	if err != nil {
		return nil, err
	}
	if runtime.GOOS == "windows" && flags&os.O_CREATE != 0 && mode.Perm()&0077 == 0 {
		if err = Chmod(path, mode); err != nil {
			file.Close()
			return nil, err
		}
	}
	return file, nil
}
