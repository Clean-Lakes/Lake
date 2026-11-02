//go:build unix

package platform

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"reflect"
	"syscall"

	"golang.org/x/sys/unix"
)

// SecurityFileIdentity excludes access time, which a read can change, and
// includes change time so restoring mtime cannot conceal a content replacement.
func SecurityFileIdentity(info os.FileInfo) (string, error) {
	return securityFileIdentity(info, true)
}

// SecurityFileStableIdentity permits an active log to grow while retaining
// the exact inode, ownership, mode and link count authorized for that probe.
func SecurityFileStableIdentity(info os.FileInfo) (string, error) {
	return securityFileIdentity(info, false)
}

func securityFileIdentity(info os.FileInfo, strict bool) (string, error) {
	if info == nil || info.Mode()&os.ModeSymlink != 0 || (!info.Mode().IsRegular() && !info.IsDir()) {
		return "", errors.New("security: regular file or directory required")
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode().IsRegular() && st.Nlink != 1 || info.Mode()&(os.ModeSetuid|os.ModeSetgid) != 0 {
		return "", errors.New("security: unsupported file identity")
	}
	raw := fmt.Sprintf("%d:%d:%d:%d:%d:%d", st.Dev, st.Ino, st.Nlink, info.Mode(), st.Uid, st.Gid)
	if !strict {
		sum := sha256.Sum256([]byte(raw))
		return hex.EncodeToString(sum[:]), nil
	}
	value := reflect.ValueOf(st).Elem()
	change := value.FieldByName("Ctim")
	if !change.IsValid() {
		change = value.FieldByName("Ctimespec")
	}
	if !change.IsValid() {
		return "", errors.New("security: change-time identity unavailable")
	}
	sec, nsec := change.FieldByName("Sec"), change.FieldByName("Nsec")
	if !sec.IsValid() || !nsec.IsValid() {
		return "", errors.New("security: change-time identity unavailable")
	}
	raw += fmt.Sprintf(":%d:%d", sec.Int(), nsec.Int())
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:]), nil
}

// O_NOFOLLOW prevents a final-component symlink swap; O_NONBLOCK prevents a
// swapped FIFO from blocking admission before fstat rejects the object.
func OpenSecurityRootFile(root *os.Root, name string) (*os.File, error) {
	return root.OpenFile(name, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
}
