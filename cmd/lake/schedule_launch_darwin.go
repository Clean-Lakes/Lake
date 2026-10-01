//go:build darwin

package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const scheduleLaunchLabel = "com.cleanlakes.lake.scheduler"

func scheduleLaunchPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", scheduleLaunchLabel+".plist"), nil
}
func xmlEscape(value string) string {
	var b bytes.Buffer
	for _, r := range value {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '"':
			b.WriteString("&quot;")
		case '\'':
			b.WriteString("&apos;")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func scheduleLaunchPlist(binary, root, logPath string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>%s</string>
<key>ProgramArguments</key><array><string>%s</string><string>schedule</string><string>serve</string></array>
<key>EnvironmentVariables</key><dict><key>LAKE_HOME</key><string>%s</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>%s</string>
<key>StandardErrorPath</key><string>%s</string>
</dict></plist>
`, scheduleLaunchLabel, xmlEscape(binary), xmlEscape(root), xmlEscape(logPath), xmlEscape(logPath))
}

func installScheduleLaunchAgent(root string, out io.Writer) error {
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	binary, err = filepath.EvalSymlinks(binary)
	if err != nil {
		return err
	}
	if err := exec.Command("codesign", "--verify", "--strict", binary).Run(); err != nil {
		return errors.New("计划服务需要已签名的 Lake 可执行文件；请先运行 scripts/build_lake.sh")
	}
	metadata, err := exec.Command("codesign", "-dv", "--verbose=4", binary).CombinedOutput()
	if err != nil || !bytes.Contains(metadata, []byte("Authority=Lake Local Development Code Signing")) || !bytes.Contains(metadata, []byte("Identifier=com.cleanlakes.lake")) {
		return errors.New("可执行文件不是 Lake Local Development Code Signing 签名")
	}
	path, err := scheduleLaunchPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	logPath := filepath.Join(root, "scheduler.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_ = logFile.Close()
	plist := scheduleLaunchPlist(binary, root, logPath)
	if _, err := os.Stat(path); err == nil {
		_ = exec.Command("launchctl", "bootout", "gui/"+strconv.Itoa(os.Getuid()), path).Run()
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".lake-scheduler-*.plist")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(plist); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	result, err := exec.Command("launchctl", "bootstrap", "gui/"+strconv.Itoa(os.Getuid()), path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("安装 LaunchAgent 失败: %s", strings.TrimSpace(string(result)))
	}
	_, err = fmt.Fprintf(out, "已安装 %s，使用 %s\n", scheduleLaunchLabel, binary)
	return err
}

func uninstallScheduleLaunchAgent(out io.Writer) error {
	path, err := scheduleLaunchPath()
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		_, err = fmt.Fprintf(out, "计划服务未安装\n")
		return err
	} else if err != nil {
		return err
	}
	_ = exec.Command("launchctl", "bootout", "gui/"+strconv.Itoa(os.Getuid()), path).Run()
	if err := os.Remove(path); err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "已卸载 %s\n", scheduleLaunchLabel)
	return err
}
