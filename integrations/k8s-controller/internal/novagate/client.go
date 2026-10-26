// Package novagate is a small, bounded client for the NovaGate admin API,
// authenticated with a workspace automation token. Adapted from the
// Terraform provider's client: HTTPS only (except loopback), no redirects,
// bounded responses, and no retried writes.
package novagate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const maxResponseBytes = 4 << 20

var (
	tenantPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$`)
	tokenPattern  = regexp.MustCompile(`^ngat_[A-Za-z0-9_-]{43}$`)
)

// ErrNotFound reports a missing, deleted or revoked object.
var ErrNotFound = errors.New("not found")

// APIError carries the HTTP status and the API's display message.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("NovaGate API returned %d: %s", e.Status, e.Message)
}

type Client struct {
	base   *url.URL
	tenant string
	token  string
	http   *http.Client
}

// New validates the configuration before any request is sent. HTTPS is
// required except for loopback development servers.
func New(apiURL, tenant, token string) (*Client, error) {
	parsed, err := url.Parse(strings.TrimRight(apiURL, "/"))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("NOVAGATE_API_URL must be an absolute URL without credentials, query or fragment, such as https://admin.example.com/api")
	}
	loopback := parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1"
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopback) {
		return nil, errors.New("NOVAGATE_API_URL must use HTTPS (plain HTTP is allowed only for localhost)")
	}
	if !tenantPattern.MatchString(tenant) {
		return nil, errors.New("NOVAGATE_TENANT_ID must be the workspace UUID")
	}
	if !tokenPattern.MatchString(token) {
		return nil, errors.New("NOVAGATE_TOKEN must be a NovaGate automation token (ngat_…); create one in Settings or with gwx tokens create")
	}
	return &Client{
		base:   parsed,
		tenant: strings.ToLower(tenant),
		token:  token,
		http: &http.Client{
			Timeout: 30 * time.Second,
			// Never forward the token to another origin.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

func (c *Client) Tenant() string { return c.tenant }

// Do sends one request; writes are never retried because they may have
// committed before a timeout.
func (c *Client) Do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	target := *c.base
	target.Path = c.base.Path + "/tenants/" + c.tenant + path
	request, err := http.NewRequestWithContext(ctx, method, target.String(), reader)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("NovaGate API request failed: %w", err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return fmt.Errorf("reading NovaGate API response: %w", err)
	}
	if len(payload) > maxResponseBytes {
		return errors.New("NovaGate API response exceeds 4 MiB")
	}
	if response.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if response.StatusCode >= 300 {
		message := http.StatusText(response.StatusCode)
		var problem struct {
			Message any `json:"message"`
		}
		if json.Unmarshal(payload, &problem) == nil {
			switch value := problem.Message.(type) {
			case string:
				message = value
			case []any:
				parts := make([]string, 0, len(value))
				for _, item := range value {
					parts = append(parts, fmt.Sprint(item))
				}
				message = strings.Join(parts, ". ")
			}
		}
		return &APIError{Status: response.StatusCode, Message: message}
	}
	if out == nil || len(payload) == 0 {
		return nil
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("NovaGate API returned invalid JSON: %w", err)
	}
	return nil
}

// Target is one upstream of a service.
type Target struct {
	URL    string `json:"url"`
	Weight int64  `json:"weight"`
}

// Service holds the fields the controller manages; others keep their
// defaults and are left alone on update.
type Service struct {
	ID              string   `json:"id,omitempty"`
	Name            string   `json:"name"`
	Targets         []Target `json:"targets"`
	HealthCheckPath string   `json:"healthCheckPath"`
	TimeoutMs       int64    `json:"timeoutMs"`
	LoadBalancing   string   `json:"loadBalancing"`
}

type Route struct {
	ID                string          `json:"id,omitempty"`
	Method            string          `json:"method"`
	PathPattern       string          `json:"pathPattern"`
	ServiceID         string          `json:"serviceId"`
	AuthRequired      bool            `json:"authRequired"`
	Enabled           bool            `json:"enabled"`
	RateLimitOverride *int64          `json:"rateLimitOverride"`
	Plugins           json.RawMessage `json:"plugins"`
}

func (c *Client) Routes(ctx context.Context) ([]Route, error) {
	var routes []Route
	return routes, c.Do(ctx, http.MethodGet, "/routes", nil, &routes)
}

func (c *Client) Services(ctx context.Context) ([]Service, error) {
	var services []Service
	return services, c.Do(ctx, http.MethodGet, "/services", nil, &services)
}

func (c *Client) CreateRoute(ctx context.Context, route Route) (Route, error) {
	var created Route
	return created, c.Do(ctx, http.MethodPost, "/routes", route, &created)
}

func (c *Client) UpdateRoute(ctx context.Context, id string, route Route) (Route, error) {
	var updated Route
	route.ID = ""
	return updated, c.Do(ctx, http.MethodPut, "/routes/"+url.PathEscape(id), route, &updated)
}

// DeleteRoute soft-deletes; a route already gone is not an error.
func (c *Client) DeleteRoute(ctx context.Context, id string) error {
	if err := c.Do(ctx, http.MethodDelete, "/routes/"+url.PathEscape(id), nil, nil); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	return nil
}

func (c *Client) CreateService(ctx context.Context, service Service) (Service, error) {
	var created Service
	return created, c.Do(ctx, http.MethodPost, "/services", service, &created)
}

func (c *Client) UpdateService(ctx context.Context, id string, service Service) (Service, error) {
	var updated Service
	service.ID = ""
	return updated, c.Do(ctx, http.MethodPut, "/services/"+url.PathEscape(id), service, &updated)
}

// DeleteService soft-deletes; a service already gone is not an error.
func (c *Client) DeleteService(ctx context.Context, id string) error {
	if err := c.Do(ctx, http.MethodDelete, "/services/"+url.PathEscape(id), nil, nil); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	return nil
}
