//go:build windows

package platform

import (
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"strings"
	"unsafe"
)

func userSID() (*windows.SID, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return user.User.Sid, nil
}
func Owned(info os.FileInfo) bool { return info != nil }
func Private(path string, info os.FileInfo) bool {
	if info == nil {
		return false
	}
	sid, err := userSID()
	if err != nil {
		return false
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false
	}
	owner, _, err := sd.Owner()
	if err != nil || !owner.Equals(sid) {
		return false
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil || acl.AceCount == 0 {
		return false
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return false
	}
	userAllowed := false
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, i, &ace) != nil {
			return false
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return false
		}
		principal := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !principal.Equals(sid) && !principal.Equals(system) {
			return false
		}
		userAllowed = userAllowed || principal.Equals(sid)
	}
	return userAllowed
}
func protect(path string, directory bool) error {
	sid, err := userSID()
	if err != nil {
		return err
	}
	flags := ""
	if directory {
		flags = "OICI"
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;" + flags + ";FA;;;" + sid.String() + ")(A;" + flags + ";FA;;;SY)")
	if err != nil {
		return err
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, sid, nil, acl, nil)
}
func MkdirAll(path string, mode os.FileMode) error {
	if err := os.MkdirAll(path, mode); err != nil {
		return err
	}
	return protect(path, true)
}
func Chmod(path string, mode os.FileMode) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return os.ErrPermission
	}
	if mode.Perm()&0077 != 0 {
		return os.Chmod(path, mode)
	}
	return protect(path, info.IsDir())
}
func ReplaceFile(from, to string) error {
	a, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	b, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(a, b, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
func SyncDirectory(string) error { return nil } // Windows durability is handled by file.Sync and MOVEFILE_WRITE_THROUGH.
func PortableRoot() string {
	if root := os.Getenv("LAKE_PORTABLE_ROOT"); root != "" {
		return root
	}
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "git")
}
func Executable(name string) string {
	leaf := filepath.Base(strings.ReplaceAll(name, "/", string(filepath.Separator)))
	if !strings.HasSuffix(strings.ToLower(leaf), ".exe") {
		leaf += ".exe"
	}
	for _, dir := range []string{"usr/bin", "bin", "ucrt64/bin", "mingw64/bin"} {
		p := filepath.Join(PortableRoot(), dir, leaf)
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p
		}
	}
	if strings.ContainsAny(name, "/\\") {
		return leaf
	}
	return name
}
func Environment(home string) []string {
	values := map[string]string{}
	for _, item := range os.Environ() {
		if key, value, ok := strings.Cut(item, "="); ok {
			values[strings.ToUpper(key)] = value
		}
	}
	values["HOME"] = filepath.ToSlash(home)
	values["PATH"] = filepath.Join(PortableRoot(), "usr/bin") + ";" + filepath.Join(PortableRoot(), "ucrt64/bin") + ";" + filepath.Join(PortableRoot(), "mingw64/bin") + ";" + values["PATH"]
	values["LANG"] = "en_US.UTF-8"
	values["MSYSTEM"] = "MINGW64"
	if info, err := os.Stat(filepath.Join(PortableRoot(), "ucrt64")); err == nil && info.IsDir() {
		values["MSYSTEM"] = "UCRT64"
	}
	env := make([]string, 0, len(values))
	for key, value := range values {
		env = append(env, key+"="+value)
	}
	return env
}
func NullDevice() string { return os.DevNull }

// Git Bash reports POSIX mount paths; store native paths so cwd observations
// pass the same absolute-path validation as Windows file operations.
func FromShellPath(path string) string {
	if filepath.IsAbs(path) || !strings.HasPrefix(path, "/") {
		return path
	}
	if len(path) >= 3 && path[2] == '/' && ((path[1] >= 'a' && path[1] <= 'z') || (path[1] >= 'A' && path[1] <= 'Z')) {
		return strings.ToUpper(path[1:2]) + ":" + filepath.FromSlash(path[2:])
	}
	return filepath.Join(PortableRoot(), filepath.FromSlash(path))
}
