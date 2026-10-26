package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"

	"github.com/mayank-rawat98/novagate/integrations/terraform-provider/internal/client"
)

// Acceptance tests run the real Terraform CLI against a real admin API.
// tools/terraform-acceptance.mjs provisions a disposable workspace, a scoped
// automation token and these variables, then verifies soft deletes in
// PostgreSQL after destroy.
var factories = map[string]func() (tfprotov6.ProviderServer, error){
	"novagate": providerserver.NewProtocol6WithError(New("test")()),
}

func preCheck(t *testing.T) {
	for _, name := range []string{"NOVAGATE_API_URL", "NOVAGATE_TENANT_ID", "NOVAGATE_API_TOKEN"} {
		if os.Getenv(name) == "" {
			t.Fatalf("%s must be set for acceptance tests", name)
		}
	}
}

func apiClient(t *testing.T) *client.Client {
	c, err := client.New(os.Getenv("NOVAGATE_API_URL"), os.Getenv("NOVAGATE_TENANT_ID"), os.Getenv("NOVAGATE_API_TOKEN"))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

const lifecycleConfig = `
provider "novagate" {}

data "novagate_tenant" "current" {}

resource "novagate_service" "users" {
  name = "users-api"
  targets = [
    { url = "https://users-a.internal.test", weight = 70 },
    { url = "https://users-b.internal.test" },
  ]
  load_balancing = %[1]q
  %[7]s
}

resource "novagate_route" "list_users" {
  method        = "GET"
  path_pattern  = "/users"
  service_id    = novagate_service.users.id
  auth_required = true
  %[2]s
  plugins = jsonencode([
    { name = "rate-limit", config = { windowMs = 1000, max = %[3]d } },
    { name = "cors", config = { origins = ["https://app.example.test"], credentials = true } },
  ])
  portal = {
    visible = true
    summary = %[4]q
  }
}

resource "novagate_consumer" "mobile" {
  name   = "mobile-app"
  groups = %[5]s
}

data "novagate_consumer" "mobile" {
  name       = novagate_consumer.mobile.name
  depends_on = [novagate_consumer.mobile]
}

resource "novagate_alert_rule" "errors" {
  name           = "High error rate"
  metric         = "error_rate"
  operator       = ">"
  threshold      = %[6]s
  window_minutes = 5
}
`

func config(balancing, retry string, max int, summary, groups, threshold string, breaker ...string) string {
	return fmt.Sprintf(lifecycleConfig, balancing, retry, max, summary, groups, threshold, strings.Join(breaker, ""))
}

func TestAccNovaGateLifecycle(t *testing.T) {
	var routeID, serviceID, consumerID string
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { preCheck(t) },
		ProtoV6ProviderFactories: factories,
		Steps: []resource.TestStep{
			{
				Config: config("weighted-round-robin", "", 30, "List users", `["read-only"]`, "0.05"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("data.novagate_tenant.current", "id", os.Getenv("NOVAGATE_TENANT_ID")),
					resource.TestCheckResourceAttr("novagate_service.users", "targets.1.weight", "100"),
					resource.TestCheckResourceAttr("novagate_service.users", "health_check_path", "/health"),
					// Omitted means no breaker, even though API-created services default to one.
					resource.TestCheckNoResourceAttr("novagate_service.users", "circuit_breaker"),
					resource.TestCheckResourceAttr("novagate_route.list_users", "enabled", "true"),
					resource.TestCheckResourceAttr("novagate_route.list_users", "portal.summary", "List users"),
					resource.TestCheckNoResourceAttr("novagate_route.list_users", "retry"),
					resource.TestMatchResourceAttr("novagate_consumer.mobile", "api_key", regexp.MustCompile(`^gw_[0-9a-f-]{36}_[0-9a-f]{32}$`)),
					resource.TestCheckResourceAttr("novagate_consumer.mobile", "groups.#", "1"),
					resource.TestCheckResourceAttrPair("data.novagate_consumer.mobile", "id", "novagate_consumer.mobile", "id"),
					resource.TestCheckResourceAttr("novagate_alert_rule.errors", "min_requests", "1"),
					resource.TestCheckResourceAttr("novagate_alert_rule.errors", "enabled", "true"),
					func(s *terraform.State) error {
						routeID = s.RootModule().Resources["novagate_route.list_users"].Primary.ID
						serviceID = s.RootModule().Resources["novagate_service.users"].Primary.ID
						consumerID = s.RootModule().Resources["novagate_consumer.mobile"].Primary.ID
						route, err := apiClient(t).Route(context.Background(), routeID)
						if err != nil {
							return err
						}
						if route.ServiceID != serviceID || route.Portal == nil || !route.Portal.Visible {
							return fmt.Errorf("API route does not match the configuration: %+v", route)
						}
						return nil
					},
				),
			},
			{
				// In-place updates, including nested objects and plugin JSON.
				Config: config("least-connections", `retry = { attempts = 2, on = [502, 503], methods = ["GET"] }
  rate_limit_override = 250`, 60, "List all users", `["read-only", "partners"]`, "0.1",
					`circuit_breaker = { open_ms = 5000, minimum_requests = 8 }`),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("novagate_service.users", "load_balancing", "least-connections"),
					resource.TestCheckResourceAttr("novagate_service.users", "circuit_breaker.enabled", "true"),
					resource.TestCheckResourceAttr("novagate_service.users", "circuit_breaker.window_size", "20"),
					resource.TestCheckResourceAttr("novagate_service.users", "circuit_breaker.open_ms", "5000"),
					resource.TestCheckResourceAttr("novagate_service.users", "circuit_breaker.minimum_requests", "8"),
					func(s *terraform.State) error {
						service, err := apiClient(t).Service(context.Background(), serviceID)
						if err != nil {
							return err
						}
						if service.CircuitBreaker == nil || service.CircuitBreaker.OpenMs != 5000 || service.CircuitBreaker.FailureRatePercent != 50 {
							return fmt.Errorf("API breaker does not match the configuration: %+v", service.CircuitBreaker)
						}
						return nil
					},
					resource.TestCheckResourceAttr("novagate_route.list_users", "retry.attempts", "2"),
					resource.TestCheckResourceAttr("novagate_route.list_users", "rate_limit_override", "250"),
					resource.TestCheckResourceAttr("novagate_route.list_users", "portal.summary", "List all users"),
					resource.TestCheckResourceAttr("novagate_consumer.mobile", "groups.#", "2"),
					resource.TestCheckResourceAttr("novagate_alert_rule.errors", "threshold", "0.1"),
					resource.TestCheckResourceAttr("novagate_alert_rule.errors", "revision", "2"),
					func(s *terraform.State) error {
						if s.RootModule().Resources["novagate_route.list_users"].Primary.ID != routeID {
							return errors.New("route was replaced instead of updated")
						}
						if s.RootModule().Resources["novagate_consumer.mobile"].Primary.ID != consumerID {
							return errors.New("consumer was replaced instead of updated")
						}
						return nil
					},
				),
			},
			{
				// Clearing optional settings sends explicit nulls.
				Config: config("least-connections", "", 60, "List all users", `["partners"]`, "0.1"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckNoResourceAttr("novagate_route.list_users", "retry"),
					resource.TestCheckNoResourceAttr("novagate_route.list_users", "rate_limit_override"),
					resource.TestCheckNoResourceAttr("novagate_service.users", "circuit_breaker"),
				),
			},
			{ResourceName: "novagate_service.users", ImportState: true, ImportStateVerify: true},
			{
				ResourceName: "novagate_route.list_users", ImportState: true, ImportStateVerify: true,
				// PostgreSQL JSONB reorders object keys; compare plugins semantically.
				ImportStateVerifyIgnore: []string{"plugins"},
				ImportStateCheck: func(states []*terraform.InstanceState) error {
					var imported []map[string]any
					if err := json.Unmarshal([]byte(states[0].Attributes["plugins"]), &imported); err != nil {
						return err
					}
					want := []map[string]any{
						{"name": "rate-limit", "config": map[string]any{"windowMs": 1000.0, "max": 60.0}},
						{"name": "cors", "config": map[string]any{"origins": []any{"https://app.example.test"}, "credentials": true}},
					}
					if !reflect.DeepEqual(imported, want) {
						return fmt.Errorf("imported plugins differ: %v", imported)
					}
					return nil
				},
			},
			{ResourceName: "novagate_alert_rule.errors", ImportState: true, ImportStateVerify: true},
			{
				ResourceName: "novagate_consumer.mobile", ImportState: true, ImportStateVerify: true,
				// Keys are shown once at creation and cannot be read back.
				ImportStateVerifyIgnore: []string{"api_key"},
			},
		},
		CheckDestroy: func(*terraform.State) error {
			ctx := context.Background()
			c := apiClient(t)
			if _, err := c.Route(ctx, routeID); !errors.Is(err, client.ErrNotFound) {
				return fmt.Errorf("route %s is still active: %v", routeID, err)
			}
			if _, err := c.Service(ctx, serviceID); !errors.Is(err, client.ErrNotFound) {
				return fmt.Errorf("service %s is still active: %v", serviceID, err)
			}
			if _, err := c.Consumer(ctx, consumerID); !errors.Is(err, client.ErrNotFound) {
				return fmt.Errorf("consumer %s is still active: %v", consumerID, err)
			}
			// Hand the IDs to the orchestrator, which checks the soft deletes in SQL.
			if path := os.Getenv("NOVAGATE_ACC_DESTROYED_FILE"); path != "" {
				return os.WriteFile(path, []byte(fmt.Sprintf(`{"route":%q,"service":%q,"consumer":%q}`, routeID, serviceID, consumerID)), 0o600)
			}
			return nil
		},
	})
}

func TestAccRejectsInsufficientScope(t *testing.T) {
	if os.Getenv("NOVAGATE_READ_ONLY_TOKEN") == "" {
		t.Skip("NOVAGATE_READ_ONLY_TOKEN is not set")
	}
	t.Setenv("NOVAGATE_API_TOKEN", os.Getenv("NOVAGATE_READ_ONLY_TOKEN"))
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { preCheck(t) },
		ProtoV6ProviderFactories: factories,
		Steps: []resource.TestStep{{
			Config: `
provider "novagate" {}
resource "novagate_service" "denied" {
  name    = "denied"
  targets = [{ url = "https://denied.internal.test" }]
}`,
			ExpectError: regexp.MustCompile(`services:write scope`),
		}},
	})
}
