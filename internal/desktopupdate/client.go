package desktopupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const ReleasesURL = "https://api.github.com/repos/Clean-Lakes/Lake/releases?per_page=100"

func NewHTTPClient() *http.Client {
	return &http.Client{Timeout: 20 * time.Minute, CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if len(via) >= 6 || !ValidDownloadOrigin(request.URL) {
			return errors.New("拒绝不可信的更新下载重定向")
		}
		return nil
	}}
}
func ValidDownloadOrigin(u *url.URL) bool {
	if u == nil || u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return false
	}
	switch u.Host {
	case "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return true
	}
	return false
}
func request(ctx context.Context, client *http.Client, raw string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Lake-Windows-Updater")
	if req.URL.Host == "api.github.com" {
		req.Header.Set("Accept", "application/vnd.github+json")
	} else {
		req.Header.Set("Accept", "application/octet-stream")
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, errors.New("无法连接 GitHub，请检查网络后重试")
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, errors.New("GitHub 更新请求失败或受限，请稍后重试")
	}
	return response, nil
}
func Check(ctx context.Context, client *http.Client, current string) (*Update, error) {
	update, _, err := CheckWithNotes(ctx, client, current)
	return update, err
}

// Keep the announcement available even when the installed version is current.
func CheckWithNotes(ctx context.Context, client *http.Client, current string) (*Update, string, error) {
	if _, ok := ParseVersion(current); !ok {
		return nil, "", ErrInvalidRelease
	}
	response, err := request(ctx, client, ReleasesURL)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil || len(data) > 4<<20 {
		return nil, "", ErrInvalidRelease
	}
	var releases []Release
	if json.Unmarshal(data, &releases) != nil {
		return nil, "", ErrInvalidRelease
	}
	update := Latest(releases, current)
	if update != nil {
		return update, update.ReleaseNotes, nil
	}
	installed, _ := ParseVersion(current)
	for _, release := range releases {
		version, ok := ParseVersion(release.Tag)
		if ok && version == installed && !release.Draft && !release.Prerelease && release.Target == "master" {
			return nil, strings.TrimSpace(release.Body), nil
		}
	}
	return nil, "", nil
}
func Download(ctx context.Context, client *http.Client, update Update, dest io.Writer, progress func(int)) (string, error) {
	// Validate even if a caller reconstructs Update instead of using Latest.
	release := Release{Tag: update.Tag, Target: "master", Assets: []Asset{update.Installer, update.Checksum}}
	valid := Latest([]Release{release}, "0.0.0")
	if valid == nil || valid.Version != update.Version {
		return "", ErrInvalidRelease
	}
	response, err := request(ctx, client, update.Checksum.URL)
	if err != nil {
		return "", err
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, MaxChecksumSize+1))
	response.Body.Close()
	if readErr != nil || int64(len(data)) != update.Checksum.Size {
		return "", ErrChecksum
	}
	expected, err := Checksum(data, update.Installer.Name, update.Installer.Digest)
	if err != nil {
		return "", err
	}
	response, err = request(ctx, client, update.Installer.URL)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.ContentLength >= 0 && response.ContentLength != update.Installer.Size {
		return "", ErrChecksum
	}
	hash := sha256.New()
	limited := io.LimitReader(response.Body, update.Installer.Size+1)
	writer := &progressWriter{target: io.MultiWriter(dest, hash), size: update.Installer.Size, changed: progress, last: -1}
	n, err := io.Copy(writer, limited)
	if err != nil {
		return "", errors.New("安装包下载中断，请重试")
	}
	if n != update.Installer.Size || hex.EncodeToString(hash.Sum(nil)) != expected {
		return "", ErrChecksum
	}
	if progress != nil {
		progress(100)
	}
	return expected, nil
}

type progressWriter struct {
	target        io.Writer
	size, written int64
	last          int
	changed       func(int)
}

func (w *progressWriter) Write(p []byte) (int, error) {
	n, err := w.target.Write(p)
	w.written += int64(n)
	percent := int(w.written * 100 / w.size)
	if percent > 99 {
		percent = 99
	}
	if w.changed != nil && percent != w.last {
		w.last = percent
		w.changed(percent)
	}
	return n, err
}
