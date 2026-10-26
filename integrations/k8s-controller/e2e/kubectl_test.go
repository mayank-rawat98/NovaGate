//go:build e2e

// Package e2e drives the built controller against a real kube-apiserver
// (envtest) and a real NovaGate admin API, control plane and gateway started
// by tools/k8s-e2e.mjs.
package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"sigs.k8s.io/controller-runtime/pkg/envtest"
)

func env(t *testing.T, name string) string {
	t.Helper()
	value := os.Getenv(name)
	if value == "" {
		t.Skipf("%s is not set; run tools/k8s-e2e.mjs", name)
	}
	return value
}

func until(t *testing.T, label string, timeout time.Duration, check func() bool) {
	t.Helper()
	start := time.Now()
	for !check() {
		if time.Since(start) > timeout {
			t.Fatalf("timed out: %s", label)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

type route struct {
	ID          string `json:"id"`
	Method      string `json:"method"`
	PathPattern string `json:"pathPattern"`
	ServiceID   string `json:"serviceId"`
	Plugins     []struct {
		Name string `json:"name"`
	} `json:"plugins"`
}

func TestKubectlApply(t *testing.T) {
	apiURL := env(t, "NOVAGATE_API_URL")
	tenant := env(t, "NOVAGATE_TENANT_ID")
	token := env(t, "NOVAGATE_TOKEN")
	gateway := env(t, "NOVAGATE_GATEWAY_URL")
	upstream := env(t, "UPSTREAM_URL")
	env(t, "KUBEBUILDER_ASSETS")
	evidence := map[string]any{}

	cluster := &envtest.Environment{}
	if _, err := cluster.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cluster.Stop() }()
	user, err := cluster.ControlPlane.AddUser(envtest.User{Name: "e2e-admin", Groups: []string{"system:masters"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	kubeconfig, err := user.KubeConfig()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	kubeconfigPath := filepath.Join(dir, "kubeconfig")
	if err := os.WriteFile(kubeconfigPath, kubeconfig, 0o600); err != nil {
		t.Fatal(err)
	}
	kubectl := func(args ...string) string {
		t.Helper()
		command := exec.Command(filepath.Join(os.Getenv("KUBEBUILDER_ASSETS"), "kubectl"), append([]string{"--kubeconfig", kubeconfigPath}, args...)...)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("kubectl %s: %v\n%s", strings.Join(args, " "), err, output)
		}
		return strings.TrimSpace(string(output))
	}

	// Install the CRDs and RBAC exactly as an operator would.
	kubectl("apply", "-f", "../config/crd")
	kubectl("apply", "-f", "../config/rbac/role.yaml")
	kubectl("wait", "--for=condition=Established", "crd/gatewayroutes.novagate.dev", "crd/gatewayservices.novagate.dev", "--timeout=30s")

	// The built controller, configured like the Deployment.
	controller := exec.Command("../dist/novagate-controller", "--metrics-bind-address=0", "--health-probe-bind-address=127.0.0.1:0", "--resync=30s", "--namespace=default")
	controller.Env = append(os.Environ(), "KUBECONFIG="+kubeconfigPath)
	logFile, _ := os.Create(filepath.Join(os.Getenv("E2E_ARTIFACTS"), "controller.log"))
	controller.Stdout, controller.Stderr = logFile, logFile
	if err := controller.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = controller.Process.Kill(); _ = controller.Wait() }()

	listRoutes := func() []route {
		request, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, apiURL+"/tenants/"+tenant+"/routes", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return nil
		}
		defer response.Body.Close()
		var routes []route
		_ = json.NewDecoder(response.Body).Decode(&routes)
		return routes
	}
	findUsers := func() *route {
		for _, item := range listRoutes() {
			if item.PathPattern == "/users" {
				return &item
			}
		}
		return nil
	}
	gatewayStatus := func(path string) int {
		response, err := http.Get(gateway + path)
		if err != nil {
			return 0
		}
		response.Body.Close()
		return response.StatusCode
	}

	// The service points at the test upstream; the route is the example file.
	service := fmt.Sprintf(`apiVersion: novagate.dev/v1alpha1
kind: GatewayService
metadata:
  name: users
  namespace: default
spec:
  targets:
    - url: %s
`, upstream)
	servicePath := filepath.Join(dir, "service.yaml")
	if err := os.WriteFile(servicePath, []byte(service), 0o600); err != nil {
		t.Fatal(err)
	}
	kubectl("apply", "-f", servicePath)
	applied := time.Now()
	t.Log(kubectl("apply", "-n", "default", "-f", "../examples/route.yaml"))

	kubectl("wait", "-n", "default", "--for=condition=Ready", "gatewayroute/users-api", "--timeout=60s")
	evidence["readyAfterMs"] = time.Since(applied).Milliseconds()
	created := findUsers()
	if created == nil || created.Method != "GET" || len(created.Plugins) != 1 || created.Plugins[0].Name != "cors" {
		t.Fatalf("route not created in NovaGate as applied: %+v", created)
	}
	statusID := kubectl("get", "-n", "default", "gatewayroute/users-api", "-o", "jsonpath={.status.id}")
	if statusID != created.ID {
		t.Fatalf("status.id %s does not match NovaGate route %s", statusID, created.ID)
	}
	evidence["routeId"] = created.ID
	evidence["dashboardVisibleAfterMs"] = time.Since(applied).Milliseconds()
	until(t, "gateway serves /users", 60*time.Second, func() bool { return gatewayStatus("/users") == 200 })
	evidence["gatewayServesAfterMs"] = time.Since(applied).Milliseconds()
	t.Log(kubectl("get", "-n", "default", "gatewayroutes,gatewayservices"))

	// Editing the resource updates the route in place.
	kubectl("patch", "-n", "default", "gatewayroute/users-api", "--type=merge", "-p", `{"spec":{"path":"/v2/users"}}`)
	until(t, "path updated in NovaGate", 30*time.Second, func() bool {
		for _, item := range listRoutes() {
			if item.ID == created.ID && item.PathPattern == "/v2/users" {
				return true
			}
		}
		return false
	})
	until(t, "gateway serves the new path", 30*time.Second, func() bool { return gatewayStatus("/v2/users") == 200 })

	deleted := time.Now()
	kubectl("delete", "-n", "default", "-f", "../examples/route.yaml", "--wait=true", "--timeout=60s")
	until(t, "route removed from NovaGate", 30*time.Second, func() bool {
		for _, item := range listRoutes() {
			if item.ID == created.ID {
				return false
			}
		}
		return true
	})
	until(t, "gateway stops serving it", 30*time.Second, func() bool { return gatewayStatus("/v2/users") == 404 })
	evidence["deletedAfterMs"] = time.Since(deleted).Milliseconds()
	kubectl("delete", "-f", servicePath, "--wait=true", "--timeout=60s")

	encoded, _ := json.MarshalIndent(evidence, "", "  ")
	_ = os.WriteFile(filepath.Join(os.Getenv("E2E_ARTIFACTS"), "kubectl.json"), encoded, 0o644)
	t.Logf("evidence: %s", encoded)
}
