// Package desktopupdate validates official Windows desktop releases before download.
package desktopupdate

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
)

const MaxInstallerSize int64 = 512 << 20
const MaxChecksumSize int64 = 4096

var ErrInvalidRelease = errors.New("更新发布或安装包不兼容")
var ErrChecksum = errors.New("安装包校验失败，请重新检查更新")

// Version is major.minor.patch with an optional fourth release field
// (e.g. 0.3.8 and 0.3.8.1). Three-field versions fill the fourth slot with 0,
// so 0.3.8.1 sorts after 0.3.8 and before 0.3.9.
type Version [4]uint32

func ParseVersion(s string) (Version, bool) {
	var v Version
	s = strings.TrimPrefix(s, "v")
	fields := strings.Split(s, ".")
	if len(fields) < 3 || len(fields) > 4 {
		return v, false
	}
	for i, f := range fields {
		if f == "" || len(f) > 1 && f[0] == '0' {
			return v, false
		}
		for _, ch := range f {
			if ch < '0' || ch > '9' {
				return v, false
			}
		}
		n, err := strconv.ParseUint(f, 10, 32)
		if err != nil {
			return v, false
		}
		v[i] = uint32(n)
	}
	return v, true
}
func (v Version) After(other Version) bool {
	for i := range v {
		if v[i] != other[i] {
			return v[i] > other[i]
		}
	}
	return false
}

type Asset struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	URL    string `json:"browser_download_url"`
	Digest string `json:"digest"`
}
type Release struct {
	Body       string  `json:"body"`
	Tag        string  `json:"tag_name"`
	Target     string  `json:"target_commitish"`
	Draft      bool    `json:"draft"`
	Prerelease bool    `json:"prerelease"`
	Assets     []Asset `json:"assets"`
}
type Update struct {
	ReleaseNotes        string
	Version, Tag        string
	Installer, Checksum Asset
}

func ValidAssetURL(raw, tag, name string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host == "github.com" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && u.RawPath == "" && u.Path == "/Clean-Lakes/Lake/releases/download/"+tag+"/"+name
}
func ValidDigest(digest string) bool {
	if !strings.HasPrefix(digest, "sha256:") {
		return false
	}
	value, err := hex.DecodeString(strings.TrimPrefix(digest, "sha256:"))
	return err == nil && len(value) == sha256.Size
}
func Latest(releases []Release, current string) *Update {
	installed, ok := ParseVersion(current)
	if !ok {
		return nil
	}
	var selected *Update
	newest := installed
	for _, release := range releases {
		v, ok := ParseVersion(release.Tag)
		if !ok || !v.After(newest) || release.Draft || release.Prerelease || release.Target != "master" {
			continue
		}
		number := strings.TrimPrefix(release.Tag, "v")
		name := "Lake-" + number + "-windows-x86_64-setup.exe"
		var installer, checksum Asset
		var installers, checksums int
		for _, asset := range release.Assets {
			if asset.Name == name {
				installer = asset
				installers++
			}
			if asset.Name == name+".sha256" {
				checksum = asset
				checksums++
			}
		}
		if installers != 1 || checksums != 1 || installer.Size <= 0 || installer.Size > MaxInstallerSize || checksum.Size <= 0 || checksum.Size > MaxChecksumSize || !ValidDigest(installer.Digest) || !ValidAssetURL(installer.URL, release.Tag, name) || !ValidAssetURL(checksum.URL, release.Tag, name+".sha256") {
			continue
		}
		newest = v
		selected = &Update{Version: number, Tag: release.Tag, Installer: installer, Checksum: checksum, ReleaseNotes: strings.TrimSpace(release.Body)}
	}
	return selected
}
func Checksum(data []byte, name, digest string) (string, error) {
	if len(data) == 0 || int64(len(data)) > MaxChecksumSize {
		return "", ErrChecksum
	}
	fields := strings.Fields(strings.TrimSpace(string(data)))
	if len(fields) != 2 || fields[1] != name || !ValidDigest("sha256:"+fields[0]) || !ValidDigest(digest) || !strings.EqualFold(digest, "sha256:"+fields[0]) {
		return "", ErrChecksum
	}
	return strings.ToLower(fields[0]), nil
}
func Verify(reader io.Reader, expected string, size int64) error {
	if !ValidDigest("sha256:"+expected) || size <= 0 || size > MaxInstallerSize {
		return ErrChecksum
	}
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(reader, size+1))
	if err != nil {
		return fmt.Errorf("读取安装包失败：%w", err)
	}
	if n != size || hex.EncodeToString(h.Sum(nil)) != expected {
		return ErrChecksum
	}
	return nil
}
