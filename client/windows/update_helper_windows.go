//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/Clean-Lakes/Lake/internal/desktopupdate"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"golang.org/x/sys/windows"
)

type updateJob struct {
	ParentPID     uint32 `json:"parentPid"`
	ParentStarted uint64 `json:"parentStarted"`
	Version       string `json:"version"`
	InstallerName string `json:"installerName"`
	Size          int64  `json:"size"`
	SHA256        string `json:"sha256"`
}

func processStarted(handle windows.Handle) (uint64, error) {
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return 0, err
	}
	return uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime), nil
}
func writePrivate(path string, data []byte) error {
	file, err := platform.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	return closeErr
}
func startUpdateHelper(work, home, exe string, update desktopupdate.Update, sum string) error {
	created, err := processStarted(windows.CurrentProcess())
	if err != nil {
		return fmt.Errorf("无法准备更新进程")
	}
	job := updateJob{ParentPID: uint32(os.Getpid()), ParentStarted: created, Version: update.Version, InstallerName: update.Installer.Name, Size: update.Installer.Size, SHA256: sum}
	data, _ := json.Marshal(job)
	if err = writePrivate(filepath.Join(work, "update.json"), data); err != nil {
		return fmt.Errorf("无法保存更新任务")
	}
	source, err := os.Open(exe)
	if err != nil {
		return fmt.Errorf("无法准备安装助手")
	}
	defer source.Close()
	helper := filepath.Join(work, "update-helper.exe")
	dest, err := platform.OpenFile(helper, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("无法准备安装助手")
	}
	_, err = io.Copy(dest, source)
	if err == nil {
		err = dest.Sync()
	}
	closeErr := dest.Close()
	if err != nil || closeErr != nil {
		return fmt.Errorf("无法写入安装助手")
	}
	cmd := exec.Command(helper, "--install-update", filepath.Join(work, "update.json"))
	cmd.Env = append(os.Environ(), "LAKE_HOME="+home)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err = cmd.Start(); err != nil {
		return fmt.Errorf("无法启动安装助手")
	}
	defer cmd.Process.Release()
	// Do not exit Lake until the helper has verified the file and captured an
	// OS handle to this exact parent process (safe against PID reuse).
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if _, err = os.Stat(filepath.Join(work, "ready")); err == nil {
			return nil
		}
		if _, err = os.Stat(filepath.Join(work, "error")); err == nil {
			return fmt.Errorf("安装助手验证失败，请重新检查更新")
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = writePrivate(filepath.Join(work, "abort"), []byte("cancelled"))
	return fmt.Errorf("安装助手未就绪，当前客户端保持运行")
}
func readUpdateJob(path, home string) (updateJob, string, error) {
	var job updateJob
	absolute, err := filepath.Abs(path)
	if err != nil {
		return job, "", err
	}
	root, err := filepath.Abs(filepath.Join(home, "updates", "windows"))
	if err != nil {
		return job, "", err
	}
	work := filepath.Dir(absolute)
	if filepath.Base(absolute) != "update.json" || !strings.EqualFold(filepath.Dir(work), root) || !strings.HasPrefix(filepath.Base(work), "job-") {
		return job, "", fmt.Errorf("更新任务路径无效")
	}
	for _, value := range []string{root, work, absolute} {
		info, err := os.Stat(value)
		if err != nil || !platform.Private(value, info) {
			return job, "", fmt.Errorf("更新任务权限无效")
		}
	}
	info, _ := os.Stat(absolute)
	if info.Size() > 4096 {
		return job, "", fmt.Errorf("更新任务过大")
	}
	data, err := os.ReadFile(absolute)
	if err != nil {
		return job, "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&job); err != nil {
		return job, "", err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return job, "", fmt.Errorf("更新任务格式无效")
	}
	next, valid := desktopupdate.ParseVersion(job.Version)
	current, _ := desktopupdate.ParseVersion(version)
	if !valid || !next.After(current) || job.Version[0] == 'v' || job.ParentPID == 0 || job.ParentStarted == 0 || !desktopupdate.ValidDigest("sha256:"+job.SHA256) || job.Size <= 0 || job.Size > desktopupdate.MaxInstallerSize || job.InstallerName != "Lake-"+job.Version+"-windows-x86_64-setup.exe" {
		return job, "", fmt.Errorf("更新任务内容无效")
	}
	installer := filepath.Join(work, job.InstallerName)
	fileInfo, err := os.Stat(installer)
	if err != nil || !platform.Private(installer, fileInfo) || !fileInfo.Mode().IsRegular() {
		return job, "", fmt.Errorf("更新安装包权限无效")
	}
	file, err := os.Open(installer)
	if err != nil {
		return job, "", err
	}
	defer file.Close()
	if err = desktopupdate.Verify(file, job.SHA256, job.Size); err != nil {
		return job, "", err
	}
	return job, work, nil
}
func runUpdateHelper(path string) error {
	home := os.Getenv("LAKE_HOME")
	if home == "" {
		return fmt.Errorf("更新数据目录无效")
	}
	job, work, err := readUpdateJob(path, home)
	if err != nil {
		return err
	}
	failure := func(err error) error {
		_ = writePrivate(filepath.Join(work, "error"), []byte("更新安装失败，请重新下载安装包。"))
		return err
	}
	parent, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, job.ParentPID)
	if err != nil {
		return failure(fmt.Errorf("更新来源进程无效"))
	}
	defer windows.CloseHandle(parent)
	created, err := processStarted(parent)
	if err != nil || created != job.ParentStarted {
		return failure(fmt.Errorf("更新来源进程已变化"))
	}
	if err = writePrivate(filepath.Join(work, "ready"), []byte("ready")); err != nil {
		return failure(fmt.Errorf("安装助手未就绪"))
	}
	result, err := windows.WaitForSingleObject(parent, 60000)
	if err != nil || result != windows.WAIT_OBJECT_0 {
		return failure(fmt.Errorf("Lake 后台尚未退出，更新已取消"))
	}
	if _, err = os.Stat(filepath.Join(work, "abort")); err == nil {
		return nil
	}
	// A timed-out or cancelled handoff removes the private job. Revalidate
	// both the authorization record and installer immediately before launch.
	if _, _, err = readUpdateJob(path, home); err != nil {
		return failure(fmt.Errorf("更新任务已取消或校验失败"))
	}
	// The original process is fully gone, so backend SQLite/terminal handles
	// and executables are no longer locked. NSIS preserves user data.
	cmd := exec.Command(filepath.Join(work, job.InstallerName), "/S", "/LAKEUPDATE")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Env = os.Environ()
	if err = cmd.Run(); err != nil {
		return failure(fmt.Errorf("更新安装失败，请手动运行已下载的安装包"))
	}
	if err = writePrivate(filepath.Join(work, "complete"), []byte(job.Version)); err != nil {
		return err
	}
	// NSIS has exited; remove the large installer immediately. The replacement
	// retries cleanup of the locked helper and completion marker after this exits.
	_ = os.Remove(filepath.Join(work, job.InstallerName))
	return nil
}
