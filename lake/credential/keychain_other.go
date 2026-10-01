//go:build !darwin || !cgo

package credential

import "errors"

type Keychain struct{}

var errUnavailable = errors.New("导入 SSH 私钥需要启用 cgo 的 macOS 构建")

func (Keychain) Import([]byte) (string, error)          { return "", errUnavailable }
func (Keychain) Load(string) ([]byte, error)            { return nil, errUnavailable }
func (Keychain) Delete(string) error                    { return errUnavailable }
func (Keychain) PutModelAPIKey(string, []byte) error    { return errUnavailable }
func (Keychain) LoadModelAPIKey(string) ([]byte, error) { return nil, errUnavailable }
func (Keychain) DeleteModelAPIKey(string) error         { return errUnavailable }
