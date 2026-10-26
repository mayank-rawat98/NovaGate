package novagate

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

const tenant = "11111111-2222-4333-8444-555555555555"
const token = "ngat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"

func TestClient(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/tenants/"+tenant+"/routes":
			_ = json.NewEncoder(w).Encode([]Route{{ID: "r1", Method: "GET", PathPattern: "/users"}})
		case r.Method == http.MethodPost && r.URL.Path == "/api/tenants/"+tenant+"/routes":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"message":["path must start with /","method is invalid"]}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	api, err := New(server.URL+"/api", tenant, token)
	if err != nil {
		t.Fatal(err)
	}
	routes, err := api.Routes(context.Background())
	if err != nil || len(routes) != 1 || routes[0].PathPattern != "/users" {
		t.Fatalf("routes = %+v, %v", routes, err)
	}
	_, err = api.CreateRoute(context.Background(), Route{Method: "GET"})
	var apiError *APIError
	if !errors.As(err, &apiError) || apiError.Status != 400 || apiError.Message != "path must start with /. method is invalid" {
		t.Fatalf("create error = %v", err)
	}
	// Deleting something already gone succeeds.
	if err := api.DeleteRoute(context.Background(), "r1"); err != nil {
		t.Fatal(err)
	}
	if seen[0] != "GET /api/tenants/"+tenant+"/routes Bearer "+token {
		t.Fatalf("unexpected request %q", seen[0])
	}
}

func TestNewRefusesUnsafeConfiguration(t *testing.T) {
	for _, value := range []struct{ url, tenant, token string }{
		{"http://admin.example.com/api", tenant, token},
		{"https://user:pass@admin.example.com/api", tenant, token},
		{"https://admin.example.com/api", "not-a-uuid", token},
		{"https://admin.example.com/api", tenant, "secret"},
	} {
		if _, err := New(value.url, value.tenant, value.token); err == nil {
			t.Fatalf("accepted %+v", value)
		}
	}
	if _, err := New("http://127.0.0.1:3001/api", tenant, token); err != nil {
		t.Fatalf("loopback HTTP should be allowed: %v", err)
	}
}
