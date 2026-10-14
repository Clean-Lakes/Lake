package desktopupdate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// CleanupCompletedJobs prunes only recognized Windows updater jobs after the
// replacement version is installed. Keeping complete until last permits retries
// when update-helper.exe is still locked by the departing helper process.
func CleanupCompletedJobs(root, currentVersion string) error {
	current, ok := ParseVersion(currentVersion)
	if !ok {
		return ErrInvalidRelease
	}
	st, err := os.Lstat(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("invalid update cache root")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	var failures []error
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "job-") || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		work := filepath.Join(root, entry.Name())
		realRoot, rootErr := filepath.EvalSymlinks(root)
		realWork, workErr := filepath.EvalSymlinks(work)
		if rootErr != nil || workErr != nil || !strings.EqualFold(filepath.Clean(realWork), filepath.Join(realRoot, entry.Name())) {
			continue
		}
		marker := filepath.Join(work, "complete")
		info, err := os.Lstat(marker)
		if err != nil || !info.Mode().IsRegular() || info.Size() > 64 {
			continue
		}
		data, err := os.ReadFile(marker)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		version := strings.TrimSpace(string(data))
		installed, ok := ParseVersion(version)
		if !ok || installed.After(current) {
			continue
		}
		if _, err = os.Lstat(filepath.Join(work, "error")); !os.IsNotExist(err) {
			continue
		}
		files, err := os.ReadDir(work)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		known := map[string]bool{"complete": true, "ready": true, "update.json": true, "update-helper.exe": true, "Lake-" + version + "-windows-x86_64-setup.exe": true}
		safe := true
		for _, file := range files {
			info, err := file.Info()
			if err != nil || !known[file.Name()] || !info.Mode().IsRegular() || file.Type()&os.ModeSymlink != 0 {
				safe = false
				break
			}
		}
		if !safe {
			continue
		}
		failed := false
		for _, file := range files {
			if file.Name() == "complete" {
				continue
			}
			if err = os.Remove(filepath.Join(work, file.Name())); err != nil {
				failed = true
				failures = append(failures, err)
				break
			}
		}
		if failed {
			continue
		}
		if err = os.Remove(marker); err != nil {
			failures = append(failures, err)
			continue
		}
		if err = os.Remove(work); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
