package web

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func syntheticKubeconfig(endpoint, token string) string {
	return fmt.Sprintf(`apiVersion: v1
kind: Config
preferences: {}
current-context: production
clusters:
- name: primary
  cluster:
    server: %q
contexts:
- name: production
  context:
    cluster: primary
    user: app
    namespace: workloads
- name: staging
  context:
    cluster: primary
    user: app
    namespace: staging
users:
- name: app
  user:
    token: %q
`, endpoint, token)
}
func withKubeCA(raw string, certificate *x509.Certificate) string {
	data := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw})
	return strings.Replace(raw, "  cluster:\n", "  cluster:\n    certificate-authority-data: "+base64.StdEncoding.EncodeToString(data)+"\n", 1)
}
func kubeSettings(raw string) Object {
	return Object{"authMethod": "kubeconfig", "kubeconfig": raw, "requestTimeout": 5, "tlsMode": "config"}
}

func TestKubeconfigResourceStoresPrivateContentAndResolvesContext(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	secret := "synthetic-kube-private-token"
	raw := syntheticKubeconfig("https://cluster.example:6443", secret)
	settings := kubeSettings(raw)
	settings["context"] = "staging"
	settings["namespace"] = "override"
	resource := apiTest(t, h, "POST", "/api/projects/"+project+"/resources", Object{"kind": "kubernetes", "name": "Kubeconfig cluster", "settings": settings}, 201)
	cfg := object(resource["settings"])
	if cfg["context"] != "staging" || cfg["namespace"] != "override" || cfg["endpoint"] != "https://cluster.example:6443" || cfg["authMethod"] != "kubeconfig" {
		t.Fatal("context metadata not resolved")
	}
	ref := stringOf(cfg["credentialRef"])
	path := filepath.Join(b.Models.Home, "secrets", ref)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved Object
	if json.Unmarshal(data, &saved) != nil || saved["kubeconfig"] != raw {
		t.Fatal("raw kubeconfig not privately preserved")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("kubeconfig file permissions")
	}
	for _, public := range []any{resource, b.Store.Catalog(), b.Store.Snapshot(sid)} {
		if text := jsonText(public); strings.Contains(text, secret) || strings.Contains(text, "current-context") || strings.Contains(text, "kubeconfigFileName") {
			t.Fatal("kubeconfig content leaked into public state")
		}
	}
	settings = kubeSettings(raw)
	cfg, cleanup := prepareService(b.Models.Home, "kubernetes", settings)
	defer cleanup()
	if cfg["context"] != "production" || cfg["namespace"] != "workloads" {
		t.Fatal("current-context defaults not used")
	}
}

func TestKubeconfigRejectsInvalidAndExternalAuthenticationWithoutLeaks(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	endpoint := "/api/projects/" + project + "/resources"
	secret := "synthetic-kube-do-not-echo"
	raw := syntheticKubeconfig("https://cluster.example", secret)
	cases := []Object{
		kubeSettings(""), kubeSettings("users: ["), kubeSettings("[1,2,3]"), kubeSettings(raw + "---\nkind: Config\n"), kubeSettings(raw + "unexpected: &alias [value]\nagain: *alias\n"), kubeSettings(strings.Repeat("x", kubeconfigLimit+1)),
		kubeSettings(strings.Replace(raw, "token:", "tokenFile:", 1)),
		kubeSettings(strings.Replace(raw, "    token:", "    client-key:", 1)),
		kubeSettings(strings.Replace(raw, "  cluster:\n", "  cluster:\n    certificate-authority: /tmp/must-not-read\n", 1)),
		kubeSettings(strings.Replace(raw, "  user:\n", "  user:\n    exec: {command: must-not-execute}\n", 1)),
		kubeSettings(strings.Replace(raw, "  user:\n", "  user:\n    auth-provider: {name: must-not-run}\n", 1)),
		kubeSettings(strings.Replace(raw, "  user:\n", "  user:\n    as: other-user\n", 1)),
		kubeSettings(strings.Replace(raw, "    token:", "    client-certificate-data:", 1)),
		kubeSettings(strings.Replace(raw, "cluster: primary", "cluster: missing", 1)),
		kubeSettings(strings.Replace(raw, "user: app", "user: missing", 1)),
		kubeSettings(strings.Replace(raw, "name: staging", "name: production", 1)),
		kubeSettings(strings.Replace(raw, "https://cluster.example", "https://user:password@cluster.example", 1)),
		kubeSettings(strings.Replace(raw, "https://cluster.example", "https://cluster.example?token=private", 1)),
	}
	for _, patch := range []Object{{"context": "missing"}, {"namespace": "Invalid/Namespace"}, {"requestTimeout": 0}, {"requestTimeout": 61}, {"requestTimeout": 1.5}, {"requestTimeout": "5"}, {"tlsMode": "invalid"}, {"token": secret}, {"kubeconfigFileName": "/tmp/private"}} {
		cfg := kubeSettings(raw)
		for key, value := range patch {
			cfg[key] = value
		}
		cases = append(cases, cfg)
	}
	before := len(objects(b.Store.Catalog()["resources"]))
	for i, settings := range cases {
		result := apiTest(t, h, "POST", endpoint, Object{"kind": "kubernetes", "name": fmt.Sprint("bad-", i), "settings": settings}, 400)
		if strings.Contains(jsonText(result), secret) {
			t.Fatal("validation echoed a credential")
		}
	}
	apiTest(t, h, "POST", endpoint, Object{"kind": "kubernetes", "name": "", "settings": kubeSettings(raw)}, 400)
	files, _ := filepath.Glob(filepath.Join(b.Models.Home, "secrets", "service-secret-*"))
	if len(files) != 0 || len(objects(b.Store.Catalog()["resources"])) != before {
		t.Fatal("failed create left data or secrets")
	}
}

func TestKubeconfigConnectionProbeUsesTLSAndDoesNotPersist(t *testing.T) {
	const token = "synthetic-probe-token"
	var requests atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != "GET" || r.URL.Path != "/cluster/version" || r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(401)
			return
		}
		io.WriteString(w, `{"gitVersion":"v1.34.1"}`)
	}))
	defer server.Close()
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	raw := withKubeCA(syntheticKubeconfig(server.URL+"/cluster", token), server.Certificate())
	before := len(objects(b.Store.Catalog()["resources"]))
	// Saving validates local material but does not contact the cluster.
	created := apiTest(t, h, "POST", "/api/projects/"+project+"/resources", Object{"name": "saved kube", "kind": "kubernetes", "settings": kubeSettings(raw)}, 201)
	if requests.Load() != 0 {
		t.Fatal("save unexpectedly tested the connection")
	}
	beforeFiles, _ := filepath.Glob(filepath.Join(b.Models.Home, "secrets", "service-secret-*"))
	result := apiTest(t, h, "POST", "/api/projects/"+project+"/resources/test", Object{"kind": "kubernetes", "settings": kubeSettings(raw)}, 200)
	if result["success"] != true || result["version"] != "v1.34.1" || requests.Load() != 1 {
		t.Fatal("connection probe did not use selected cluster")
	}
	afterFiles, _ := filepath.Glob(filepath.Join(b.Models.Home, "secrets", "service-secret-*"))
	if len(afterFiles) != len(beforeFiles) || len(objects(b.Store.Catalog()["resources"])) != before+1 || created["id"] == nil {
		t.Fatal("test persisted temporary credentials or resources")
	}
	// Unknown CA fails; explicitly selecting skip succeeds. No upstream body is echoed.
	untrusted := kubeSettings(syntheticKubeconfig(server.URL+"/cluster", token))
	apiTest(t, h, "POST", "/api/projects/"+project+"/resources/test", Object{"kind": "kubernetes", "settings": untrusted}, 400)
	untrusted["tlsMode"] = "skip"
	apiTest(t, h, "POST", "/api/projects/"+project+"/resources/test", Object{"kind": "kubernetes", "settings": untrusted}, 200)
	untrusted["tlsMode"] = "verify"
	apiTest(t, h, "POST", "/api/projects/"+project+"/resources/test", Object{"kind": "kubernetes", "settings": untrusted}, 400)
}

func TestKubeconfigConnectionProbePresentsInlineClientCertificate(t *testing.T) {
	var presented atomic.Bool
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		presented.Store(len(r.TLS.PeerCertificates) == 1)
		io.WriteString(w, `{"gitVersion":"v1.33.5+k3s1"}`)
	}))
	server.TLS = &tls.Config{ClientAuth: tls.RequireAnyClientCert}
	server.StartTLS()
	defer server.Close()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(5), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	cert, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certData := base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}))
	keyData := base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}))
	raw := withKubeCA(syntheticKubeconfig(server.URL, ""), server.Certificate())
	raw = strings.Replace(raw, "    token: \"\"", "    client-certificate-data: "+certData+"\n    client-key-data: "+keyData, 1)
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	apiTest(t, h, "POST", "/api/projects/"+project+"/resources/test", Object{"kind": "kubernetes", "settings": kubeSettings(raw)}, 200)
	if !presented.Load() {
		t.Fatal("inline client certificate not presented")
	}
}

func TestKubernetesProbeRejectsRedirectsErrorsAndHonorsTimeout(t *testing.T) {
	var targetCalls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetCalls.Add(1)
		io.WriteString(w, `{"gitVersion":"v1.34.1"}`)
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect/version":
			http.Redirect(w, r, target.URL+"/version", 302)
		case "/slow/version":
			<-r.Context().Done()
		case "/unauthorized/version":
			w.WriteHeader(401)
			io.WriteString(w, "synthetic-error-secret")
		default:
			io.WriteString(w, `{"gitVersion":"upstream error with synthetic-error-secret"}`)
		}
	}))
	defer server.Close()
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	for _, path := range []string{"redirect", "unauthorized", "invalid", "slow"} {
		status := 400
		if path == "slow" {
			status = 504
		}
		result := apiTest(t, h, "POST", "/api/projects/"+project+"/resources/test", Object{"kind": "kubernetes", "settings": Object{"authMethod": "token", "endpoint": server.URL + "/" + path, "token": "synthetic-error-secret", "requestTimeout": 1}}, status)
		if strings.Contains(jsonText(result), "synthetic-error-secret") {
			t.Fatal("probe leaked upstream body or credential")
		}
	}
	if targetCalls.Load() != 0 {
		t.Fatal("redirect leaked request to a different endpoint")
	}
	files, _ := filepath.Glob(filepath.Join(b.Models.Home, "secrets", "service-secret-*"))
	if len(files) != 0 {
		t.Fatal("failed probes left credentials")
	}
}
