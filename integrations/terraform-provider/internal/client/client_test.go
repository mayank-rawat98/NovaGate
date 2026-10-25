package client

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	testTenant = "12345678-1234-1234-1234-123456789ABC"
	testToken  = "ngat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

func TestNewValidatesConfiguration(t *testing.T) {
	cases := map[string][3]string{
		"plain http remote":  {"http://admin.example.com/api", testTenant, testToken},
		"credentials in url": {"https://user:pw@admin.example.com/api", testTenant, testToken},
		"query string":       {"https://admin.example.com/api?x=1", testTenant, testToken},
		"relative url":       {"/api", testTenant, testToken},
		"invalid tenant":     {"https://admin.example.com/api", "workspace", testToken},
		"session jwt":        {"https://admin.example.com/api", testTenant, "eyJhbGciOiJIUzI1NiJ9.e30.x"},
		"short token":        {"https://admin.example.com/api", testTenant, "ngat_short"},
		"token with newline": {"https://admin.example.com/api", testTenant, testToken[:47] + "\n"},
	}
	for name, input := range cases {
		if _, err := New(input[0], input[1], input[2]); err == nil {
			t.Errorf("%s: expected a configuration error", name)
		}
	}
	for _, apiURL := range []string{"https://admin.example.com/api/", "http://127.0.0.1:3001/api", "http://localhost:3001/api"} {
		c, err := New(apiURL, testTenant, testToken)
		if err != nil {
			t.Fatalf("%s: %v", apiURL, err)
		}
		if c.Tenant() != strings.ToLower(testTenant) {
			t.Fatalf("tenant should be canonical lowercase, got %s", c.Tenant())
		}
	}
}

func TestDoSendsTokenAndMapsErrors(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization")+" "+r.Header.Get("Content-Type"))
		switch r.URL.Path {
		case "/api/tenants/12345678-1234-1234-1234-123456789abc/services":
			if r.Method == http.MethodPost {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"message":"This token needs the services:write scope"}`))
				return
			}
			_, _ = w.Write([]byte(`[{"id":"a","name":"users","targets":[{"url":"https://u.test","weight":100}]}]`))
		case "/api/tenants/12345678-1234-1234-1234-123456789abc/routes":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"message":["first problem","second problem"]}`))
		case "/api/tenants/12345678-1234-1234-1234-123456789abc/consumers":
			http.Redirect(w, r, "https://elsewhere.example/steal", http.StatusFound)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	c, err := New(server.URL+"/api", testTenant, testToken)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	service, err := c.Service(ctx, "A")
	if err != nil || service.Name != "users" || service.Targets[0].Weight != 100 {
		t.Fatalf("expected the listed service, got %+v %v", service, err)
	}
	if _, err := c.Service(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	err = c.Do(ctx, http.MethodPost, "/services", map[string]string{"name": "x"}, nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 403 || apiErr.Message != "This token needs the services:write scope" {
		t.Fatalf("expected a 403 API error, got %v", err)
	}
	err = c.Do(ctx, http.MethodGet, "/routes", nil, nil)
	if !errors.As(err, &apiErr) || apiErr.Message != "first problem. second problem" {
		t.Fatalf("expected joined validation messages, got %v", err)
	}
	// Redirects are not followed, so the token never reaches another origin.
	if err := c.Do(ctx, http.MethodGet, "/consumers", nil, nil); err == nil {
		t.Fatal("expected the redirect to be refused")
	}
	if _, err := c.TenantProfile(ctx); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for the profile, got %v", err)
	}
	for _, request := range seen {
		if !strings.Contains(request, "Bearer "+testToken) {
			t.Fatalf("request lacked the bearer token: %s", request)
		}
	}
	if !strings.HasPrefix(seen[2], "POST /api/tenants/12345678-1234-1234-1234-123456789abc/services Bearer "+testToken+" application/json") {
		t.Fatalf("unexpected write request: %s", seen[2])
	}
}

func TestDoBoundsResponses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("[" + strings.Repeat(`"x",`, maxResponseBytes/4) + `"x"]`))
	}))
	defer server.Close()
	c, _ := New(server.URL+"/api", testTenant, testToken)
	var out []string
	if err := c.Do(context.Background(), http.MethodGet, "/services", nil, &out); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("expected the oversized response to be refused, got %v", err)
	}
}
