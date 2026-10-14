package desktopupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func fixture(number string, payload []byte) Release {
	name := "Lake-" + number + "-windows-x86_64-setup.exe"
	sum := sha256.Sum256(payload)
	digest := hex.EncodeToString(sum[:])
	checksum := digest + "  " + name + "\n"
	base := "https://github.com/Clean-Lakes/Lake/releases/download/v" + number + "/"
	return Release{Tag: "v" + number, Target: "master", Assets: []Asset{{Name: name, Size: int64(len(payload)), URL: base + name, Digest: "sha256:" + digest}, {Name: name + ".sha256", Size: int64(len(checksum)), URL: base + name + ".sha256"}}}
}
func TestVersion(t *testing.T) {
	for _, s := range []string{"0.3.3", "v0.3.4", "10.20.30", "0.3.8.1", "v0.3.8.1", "1.2.3.4"} {
		if _, ok := ParseVersion(s); !ok {
			t.Fatal(s)
		}
	}
	for _, s := range []string{"0.03.3", "0.3", "0.3.4-beta", "+1.2.3", "1.2.3 ", "1.2.4294967296", "1.２.3", "1.2.3.4.5", "0.3.4.", ".3.4"} {
		if _, ok := ParseVersion(s); ok {
			t.Fatal(s)
		}
	}
	a, _ := ParseVersion("0.3.10")
	b, _ := ParseVersion("0.3.9")
	if !a.After(b) || b.After(a) || a.After(a) {
		t.Fatal("incorrect comparison")
	}
	c, _ := ParseVersion("0.3.8.1")
	d, _ := ParseVersion("0.3.8")
	e, _ := ParseVersion("0.3.8.2")
	if !c.After(d) || d.After(c) || !e.After(c) || !a.After(c) {
		t.Fatal("incorrect four-part comparison")
	}
}
func TestSelectStableWindowsMaster(t *testing.T) {
	data := []byte("MZfixture")
	releases := []Release{fixture("0.3.10", data), fixture("0.3.4", data), fixture("0.3.3", data)}
	got := Latest(releases, "0.3.3")
	if got == nil || got.Version != "0.3.10" {
		t.Fatalf("selected %+v", got)
	}
	if Latest(releases, "0.3.10") != nil || Latest(releases, "invalid") != nil {
		t.Fatal("same version or invalid current must not update")
	}
	patch := Latest([]Release{fixture("0.3.8.1", data)}, "0.3.8")
	if patch == nil || patch.Version != "0.3.8.1" {
		t.Fatalf("four-part patch release not selected: %+v", patch)
	}
	if Latest([]Release{fixture("0.3.8.1", data)}, "0.3.8.1") != nil || Latest([]Release{fixture("0.3.8", data)}, "0.3.8.1") != nil {
		t.Fatal("four-part comparison must order patch releases")
	}
	mutations := map[string]func(*Release){
		"draft": func(r *Release) { r.Draft = true }, "prerelease": func(r *Release) { r.Prerelease = true }, "other branch": func(r *Release) { r.Target = "feature" },
		"foreign repo": func(r *Release) {
			r.Assets[0].URL = strings.Replace(r.Assets[0].URL, "Clean-Lakes/Lake", "attacker/Lake", 1)
		},
		"wrong tag":  func(r *Release) { r.Assets[0].URL = strings.Replace(r.Assets[0].URL, "/v0.3.4/", "/v0.3.3/", 1) },
		"plain http": func(r *Release) { r.Assets[0].URL = strings.Replace(r.Assets[0].URL, "https:", "http:", 1) },
		"url credentials": func(r *Release) {
			r.Assets[0].URL = strings.Replace(r.Assets[0].URL, "github.com", "name@github.com", 1)
		},
		"query": func(r *Release) { r.Assets[0].URL += "?x=1" }, "fragment": func(r *Release) { r.Assets[0].URL += "#x" },
		"missing checksum": func(r *Release) { r.Assets = r.Assets[:1] }, "digest missing": func(r *Release) { r.Assets[0].Digest = "" },
		"oversized": func(r *Release) { r.Assets[0].Size = MaxInstallerSize + 1 }, "empty": func(r *Release) { r.Assets[0].Size = 0 },
		"duplicate":       func(r *Release) { r.Assets = append(r.Assets, r.Assets[0]) },
		"legacy platform": func(r *Release) { r.Assets[0].Name = "Lake-0.3.4-macos-arm64.zip" },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			r := fixture("0.3.4", data)
			mutate(&r)
			if Latest([]Release{r}, "0.3.3") != nil {
				t.Fatal("accepted unsafe release")
			}
		})
	}
}
func TestChecksumAndSize(t *testing.T) {
	data := []byte("MZfixture")
	r := fixture("0.3.4", data)
	sum := strings.TrimPrefix(r.Assets[0].Digest, "sha256:")
	good := []byte(sum + "  " + r.Assets[0].Name + "\n")
	expected, err := Checksum(good, r.Assets[0].Name, r.Assets[0].Digest)
	if err != nil || expected != sum {
		t.Fatal(err)
	}
	if err = Verify(bytes.NewReader(data), expected, int64(len(data))); err != nil {
		t.Fatal(err)
	}
	for _, broken := range [][]byte{[]byte(sum + " wrong.exe"), append(good, []byte("extra")...), []byte(strings.Repeat("x", 5000)), []byte(strings.Repeat("0", 64) + " " + r.Assets[0].Name)} {
		if _, err := Checksum(broken, r.Assets[0].Name, r.Assets[0].Digest); err == nil {
			t.Fatal("accepted corrupted checksum")
		}
	}
	if Verify(bytes.NewReader(append(data, 'x')), sum, int64(len(data))) == nil || Verify(bytes.NewReader(data[:len(data)-1]), sum, int64(len(data))) == nil || Verify(bytes.NewReader([]byte("MZtamper!")), sum, int64(len(data))) == nil {
		t.Fatal("accepted corrupt installer")
	}
}

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestDownloadVerifiedAndErrors(t *testing.T) {
	payload := []byte("MZfixture")
	r := fixture("0.3.4", payload)
	u := Latest([]Release{r}, "0.3.3")
	checksum := []byte(strings.TrimPrefix(r.Assets[0].Digest, "sha256:") + "  " + r.Assets[0].Name + "\n")
	for _, mode := range []string{"success", "bad installer", "truncated", "bad checksum", "http failure", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			client := NewHTTPClient()
			client.Transport = transportFunc(func(req *http.Request) (*http.Response, error) {
				if err := req.Context().Err(); err != nil {
					return nil, err
				}
				body := payload
				status := 200
				if req.URL.String() == u.Checksum.URL {
					body = checksum
					if mode == "bad checksum" {
						body = []byte("broken")
					}
				}
				if req.URL.String() == u.Installer.URL {
					if mode == "bad installer" {
						body = []byte("MZtamper!")
					}
					if mode == "truncated" {
						body = payload[:4]
					}
				}
				if mode == "http failure" {
					status = 429
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: -1, Header: make(http.Header), Request: req}, nil
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancelled" {
				cancel()
			}
			var dest bytes.Buffer
			var progress []int
			sum, err := Download(ctx, client, *u, &dest, func(n int) { progress = append(progress, n) })
			if mode != "success" {
				if err == nil {
					t.Fatal("expected failure")
				}
				return
			}
			if err != nil || sum != strings.TrimPrefix(u.Installer.Digest, "sha256:") || !bytes.Equal(dest.Bytes(), payload) || progress[len(progress)-1] != 100 {
				t.Fatalf("failed verified download: %v", err)
			}
		})
	}
}
func TestCheckAndRedirects(t *testing.T) {
	r := fixture("0.3.4", []byte("MZfixture"))
	data, _ := json.Marshal([]Release{r})
	client := NewHTTPClient()
	client.Transport = transportFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != ReleasesURL {
			t.Fatal("unexpected API destination")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: make(http.Header), Request: req}, nil
	})
	got, err := Check(context.Background(), client, "0.3.3")
	if err != nil || got == nil || got.Version != "0.3.4" {
		t.Fatal(err)
	}
	for _, raw := range []string{"http://github.com/a", "https://github.com.evil.test/a", "https://evil.test/a", "https://name@github.com/a", "https://github.com:444/a", "https://127.0.0.1/a"} {
		parsed, _ := url.Parse(raw)
		if client.CheckRedirect(&http.Request{URL: parsed}, nil) == nil {
			t.Fatalf("allowed redirect %s", raw)
		}
	}
	parsed, _ := url.Parse("https://release-assets.githubusercontent.com/github-production-release-asset/a?token=temporary")
	if client.CheckRedirect(&http.Request{URL: parsed}, nil) != nil {
		t.Fatal("blocked official release CDN")
	}
}

func TestReleaseNotesFollowSelectedCompatibleVersion(t *testing.T) {
	release := fixture("0.3.10", []byte("MZfixture"))
	release.Body = "  ## 更新公告\n- 一键打开终端\n- 中文菜单  "
	newer := fixture("0.4.0", []byte("MZfixture"))
	newer.Draft = true
	newer.Body = "draft notes"
	update := Latest([]Release{release, newer}, "0.3.3")
	if update == nil || update.ReleaseNotes != "## 更新公告\n- 一键打开终端\n- 中文菜单" {
		t.Fatalf("release notes not carried by selected update: %+v", update)
	}
	release.Body = ""
	if Latest([]Release{release}, "0.3.3").ReleaseNotes != "" {
		t.Fatal("missing notes must remain empty")
	}
}

func TestCheckRetainsCurrentVersionAnnouncement(t *testing.T) {
	release := fixture("0.3.10", []byte("MZfixture"))
	release.Body = "## 更新公告\n- 中文菜单"
	data, err := json.Marshal([]Release{release})
	if err != nil {
		t.Fatal(err)
	}
	client := NewHTTPClient()
	client.Transport = transportFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), Header: make(http.Header), Request: req}, nil
	})
	update, notes, err := CheckWithNotes(context.Background(), client, "0.3.10")
	if err != nil || update != nil || notes != release.Body {
		t.Fatalf("current release announcement lost: update=%+v notes=%q err=%v", update, notes, err)
	}
}
