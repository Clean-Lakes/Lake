//go:build !windows

package platform

import (
	"os"
	"path/filepath"
	"syscall"
)

func Owned(info os.FileInfo) bool {
	if info == nil {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Getuid()
}
func Private(_ string, info os.FileInfo) bool {
	return info != nil && Owned(info) && info.Mode().Perm()&0077 == 0 && (info.IsDir() || info.Mode().Perm() == 0600 || info.Mode().Perm() == 0400)
}
func MkdirAll(path string, mode os.FileMode) error { return os.MkdirAll(path, mode) }
func Chmod(path string, mode os.FileMode) error    { return os.Chmod(path, mode) }
func ReplaceFile(from, to string) error            { return os.Rename(from, to) }
func SyncDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func FromShellPath(path string) string { return path }
func Executable(name string) string    { return name }
func Environment(home string) []string {
	return []string{"HOME=" + home, "PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", "LANG=en_US.UTF-8"}
}
func NullDevice() string   { return os.DevNull }
func PortableRoot() string { return filepath.Dir(os.Args[0]) }
