// Package client is a small, bounded HTTP client for the NovaGate admin API.
// It uses workspace automation tokens and the same endpoints as the CLI.
package client

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
		return nil, errors.New("api_url must be an absolute URL without credentials, query or fragment, such as https://admin.example.com/api")
	}
	loopback := parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1"
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopback) {
		return nil, errors.New("api_url must use HTTPS (plain HTTP is allowed only for localhost)")
	}
	if !tenantPattern.MatchString(tenant) {
		return nil, errors.New("tenant_id must be the workspace UUID")
	}
	if !tokenPattern.MatchString(token) {
		return nil, errors.New("token must be a NovaGate automation token (ngat_…); create one in Settings or with gwx tokens create")
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

type Service struct {
	ID                    string   `json:"id,omitempty"`
	Name                  string   `json:"name"`
	Targets               []Target `json:"targets"`
	HealthCheckPath       string   `json:"healthCheckPath"`
	TimeoutMs             int64    `json:"timeoutMs"`
	HealthCheckIntervalMs int64    `json:"healthCheckIntervalMs"`
	HealthCheckProtocol   string   `json:"healthCheckProtocol"`
	HealthCheckService    string   `json:"healthCheckService"`
	UnhealthyFallback     bool     `json:"unhealthyFallback"`
	H2                    bool     `json:"h2"`
	SupportsWebSocket     bool     `json:"supportsWebSocket"`
	LoadBalancing         string   `json:"loadBalancing"`
	// Always sent: null means no circuit breaker.
	CircuitBreaker *CircuitBreaker `json:"circuitBreaker"`
}

// CircuitBreaker mirrors the admin API's per-service breaker settings.
type CircuitBreaker struct {
	Enabled            bool  `json:"enabled"`
	WindowSize         int64 `json:"windowSize"`
	FailureRatePercent int64 `json:"failureRatePercent"`
	MinimumRequests    int64 `json:"minimumRequests"`
	OpenMs             int64 `json:"openMs"`
	HalfOpenSuccesses  int64 `json:"halfOpenSuccesses"`
}

type Retry struct {
	Attempts int64    `json:"attempts"`
	On       []int64  `json:"on"`
	Methods  []string `json:"methods"`
}

type Portal struct {
	Visible     bool   `json:"visible"`
	Summary     string `json:"summary,omitempty"`
	Description string `json:"description,omitempty"`
}

type Route struct {
	ID                string          `json:"id,omitempty"`
	Method            string          `json:"method"`
	PathPattern       string          `json:"pathPattern"`
	ServiceID         string          `json:"serviceId"`
	AuthRequired      bool            `json:"authRequired"`
	Enabled           bool            `json:"enabled"`
	RateLimitOverride *int64          `json:"rateLimitOverride"`
	Retry             *Retry          `json:"retry"`
	Plugins           json.RawMessage `json:"plugins"`
	Portal            *Portal         `json:"portal"`
}

type Consumer struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	RateLimitTier string   `json:"rateLimitTier"`
	Groups        []string `json:"groups"`
	APIKey        string   `json:"apiKey,omitempty"`
}

type AlertRule struct {
	ID            string   `json:"id,omitempty"`
	Name          string   `json:"name"`
	Metric        string   `json:"metric"`
	Operator      string   `json:"operator"`
	Threshold     float64  `json:"threshold"`
	WindowMinutes int64    `json:"windowMinutes"`
	MinRequests   int64    `json:"minRequests"`
	ChannelIDs    []string `json:"channelIds"`
	Enabled       bool     `json:"enabled"`
	Revision      int64    `json:"revision,omitempty"`
}

type Tenant struct {
	ID                   string `json:"id"`
	Name                 string `json:"name"`
	PlanID               string `json:"planId"`
	GatewayConfigVersion int64  `json:"gatewayConfigVersion"`
}

// find returns the active entry with the id from a list endpoint.
func find[T any](items []T, id func(T) string, want string) (*T, error) {
	for index := range items {
		if strings.EqualFold(id(items[index]), want) {
			return &items[index], nil
		}
	}
	return nil, ErrNotFound
}

func (c *Client) Services(ctx context.Context) ([]Service, error) {
	var services []Service
	return services, c.Do(ctx, http.MethodGet, "/services", nil, &services)
}

func (c *Client) Service(ctx context.Context, id string) (*Service, error) {
	services, err := c.Services(ctx)
	if err != nil {
		return nil, err
	}
	return find(services, func(s Service) string { return s.ID }, id)
}

func (c *Client) Routes(ctx context.Context) ([]Route, error) {
	var routes []Route
	return routes, c.Do(ctx, http.MethodGet, "/routes", nil, &routes)
}

func (c *Client) Route(ctx context.Context, id string) (*Route, error) {
	routes, err := c.Routes(ctx)
	if err != nil {
		return nil, err
	}
	return find(routes, func(r Route) string { return r.ID }, id)
}

func (c *Client) Consumers(ctx context.Context) ([]Consumer, error) {
	var consumers []Consumer
	return consumers, c.Do(ctx, http.MethodGet, "/consumers", nil, &consumers)
}

func (c *Client) Consumer(ctx context.Context, id string) (*Consumer, error) {
	consumers, err := c.Consumers(ctx)
	if err != nil {
		return nil, err
	}
	return find(consumers, func(c Consumer) string { return c.ID }, id)
}

func (c *Client) AlertRules(ctx context.Context) ([]AlertRule, error) {
	var configuration struct {
		Rules []AlertRule `json:"rules"`
	}
	return configuration.Rules, c.Do(ctx, http.MethodGet, "/alerts", nil, &configuration)
}

func (c *Client) AlertRule(ctx context.Context, id string) (*AlertRule, error) {
	rules, err := c.AlertRules(ctx)
	if err != nil {
		return nil, err
	}
	return find(rules, func(r AlertRule) string { return r.ID }, id)
}

func (c *Client) TenantProfile(ctx context.Context) (*Tenant, error) {
	var tenant Tenant
	// GET /tenants/:id is the workspace profile itself, not a sub-resource.
	err := c.Do(ctx, http.MethodGet, "", nil, &tenant)
	if err != nil {
		return nil, err
	}
	if tenant.ID == "" {
		return nil, ErrNotFound
	}
	return &tenant, nil
}
