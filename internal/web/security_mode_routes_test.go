package web

import "testing"

func TestSecurityModeHTTPUsesHostProjectsAndFrozenCAS(t *testing.T) {
	_, h := fixture(t)
	status := apiTest(t, h, "GET", "/api/security/mode", nil, 200)
	if status["mode"] != "legacy" || number(status["revision"]) != 0 {
		t.Fatal(status)
	}
	payload := Object{"actionId": "shadow", "expectedRevision": 0, "mode": "shadow", "confirmedDigest": status["digest"]}
	first := apiTest(t, h, "POST", "/api/security/mode", payload, 200)
	if first["mode"] != "shadow" || number(first["revision"]) != 1 {
		t.Fatal(first)
	}
	apiTest(t, h, "POST", "/api/security/mode", payload, 200)
	if _, ok := first["shadowDifferences"].([]any); !ok {
		t.Fatal("management status omitted shadow review", first)
	}
	forgedDifference := Object{"actionId": "forged-shadow-ack", "expectedRevision": 1, "mode": "shadow", "confirmedDigest": first["digest"], "confirmedShadowDifferences": []string{"not-an-original-host-event"}}
	apiTest(t, h, "POST", "/api/security/mode", forgedDifference, 409)
	unchanged := apiTest(t, h, "GET", "/api/security/mode", nil, 200)
	if number(unchanged["revision"]) != 1 || unchanged["mode"] != "shadow" {
		t.Fatal("forged difference changed mode", unchanged)
	}
	forgedDifference["confirmedShadowDifferences"] = []Object{{"id": "fake", "comparison": "widening"}}
	apiTest(t, h, "POST", "/api/security/mode", forgedDifference, 400)
	forged := cloneObject(payload)
	forged["projects"] = []string{"fake"}
	apiTest(t, h, "POST", "/api/security/mode", forged, 400)
	forged = cloneObject(payload)
	forged["actorId"] = "admin"
	apiTest(t, h, "POST", "/api/security/mode", forged, 400)
	stale := cloneObject(payload)
	stale["actionId"] = "stale"
	apiTest(t, h, "POST", "/api/security/mode", stale, 409)
	unknown := cloneObject(payload)
	unknown["expectedRevision"] = 1
	unknown["actionId"] = "downgrade"
	unknown["mode"] = "legacy"
	apiTest(t, h, "POST", "/api/security/mode", unknown, 400)
}
