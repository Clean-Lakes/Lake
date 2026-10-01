/*
 * Copyright 2026 CloudWeGo Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// readIdentityFile reads a private key for import into Lake's credential vault.
func readIdentityFile(path string) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("--identity 需要私钥的绝对路径")
	}
	path = filepath.Clean(path)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("检查私钥文件: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("--identity 必须指向普通文件，不能是符号链接")
	}
	if info.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("私钥权限过宽：%s；请设为 0600 或更严格", path)
	}
	if info.Size() > 1024*1024 {
		return nil, errors.New("私钥文件超过 1 MiB")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("打开私钥文件: %w", err)
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("检查已打开私钥文件: %w", err)
	}
	if !opened.Mode().IsRegular() || !os.SameFile(info, opened) || opened.Mode().Perm()&0077 != 0 {
		return nil, errors.New("私钥文件在检查后发生变化或权限过宽")
	}
	key, err := io.ReadAll(io.LimitReader(file, 1024*1024+1))
	if err != nil {
		return nil, fmt.Errorf("读取私钥内容: %w", err)
	}
	if len(key) > 1024*1024 {
		clearBytes(key)
		return nil, errors.New("私钥文件超过 1 MiB")
	}
	if recognizedPrivateKey(key) {
		return key, nil
	}
	clearBytes(key)
	return nil, errors.New("--identity 文件不是可识别的 SSH 私钥格式")
}

func recognizedPrivateKey(key []byte) bool {
	line, _, _ := bytes.Cut(key, []byte("\n"))
	switch strings.TrimSpace(string(line)) {
	case "-----BEGIN OPENSSH PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN EC PRIVATE KEY-----", "-----BEGIN DSA PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----", "-----BEGIN ENCRYPTED PRIVATE KEY-----":
		return true
	}
	return false
}
