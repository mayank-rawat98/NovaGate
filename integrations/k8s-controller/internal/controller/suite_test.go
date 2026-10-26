package controller

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	v1alpha1 "github.com/mayank-rawat98/novagate/integrations/k8s-controller/api/v1alpha1"
	"github.com/mayank-rawat98/novagate/integrations/k8s-controller/internal/novagate"
)

// fakeAPI is an in-memory admin API that counts writes.
type fakeAPI struct {
	mu       sync.Mutex
	next     int
	routes   map[string]novagate.Route
	services map[string]novagate.Service
	writes   int
	refuse   map[string]bool
	refused  int
}

func newFakeAPI() *fakeAPI {
	return &fakeAPI{routes: map[string]novagate.Route{}, services: map[string]novagate.Service{}, refuse: map[string]bool{}}
}
func (f *fakeAPI) id(kind string) string {
	f.next++
	return fmt.Sprintf("00000000-0000-4000-8000-%012d", f.next)
}
func (f *fakeAPI) Routes(context.Context) ([]novagate.Route, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []novagate.Route{}
	for _, route := range f.routes {
		out = append(out, route)
	}
	return out, nil
}
func (f *fakeAPI) Services(context.Context) ([]novagate.Service, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []novagate.Service{}
	for _, service := range f.services {
		out = append(out, service)
	}
	return out, nil
}
func (f *fakeAPI) CreateRoute(_ context.Context, route novagate.Route) (novagate.Route, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refuse[route.PathPattern] {
		f.refused++
		return novagate.Route{}, &novagate.APIError{Status: 400, Message: "pathPattern is invalid"}
	}
	f.writes++
	route.ID = f.id("route")
	f.routes[route.ID] = route
	return route, nil
}
func (f *fakeAPI) UpdateRoute(_ context.Context, id string, route novagate.Route) (novagate.Route, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.routes[id]; !ok {
		return novagate.Route{}, novagate.ErrNotFound
	}
	f.writes++
	route.ID = id
	f.routes[id] = route
	return route, nil
}
func (f *fakeAPI) DeleteRoute(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes++
	delete(f.routes, id)
	return nil
}
func (f *fakeAPI) CreateService(_ context.Context, service novagate.Service) (novagate.Service, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes++
	service.ID = f.id("service")
	f.services[service.ID] = service
	return service, nil
}
func (f *fakeAPI) UpdateService(_ context.Context, id string, service novagate.Service) (novagate.Service, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes++
	service.ID = id
	f.services[id] = service
	return service, nil
}
func (f *fakeAPI) DeleteService(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes++
	delete(f.services, id)
	return nil
}
func (f *fakeAPI) snapshot() (map[string]novagate.Route, map[string]novagate.Service, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	routes := map[string]novagate.Route{}
	for k, v := range f.routes {
		routes[k] = v
	}
	services := map[string]novagate.Service{}
	for k, v := range f.services {
		services[k] = v
	}
	return routes, services, f.writes
}

func eventually(t *testing.T, label string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out: %s", label)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func ready(conditions []metav1.Condition) (bool, string) {
	condition := meta.FindStatusCondition(conditions, "Ready")
	if condition == nil {
		return false, ""
	}
	return condition.Status == metav1.ConditionTrue, condition.Reason
}

// TestControllers runs both reconcilers against a real kube-apiserver and
// etcd (envtest). Set KUBEBUILDER_ASSETS to a directory holding etcd,
// kube-apiserver and kubectl; without it the test is skipped.
func TestControllers(t *testing.T) {
	if os.Getenv("KUBEBUILDER_ASSETS") == "" {
		t.Skip("KUBEBUILDER_ASSETS is not set")
	}
	environment := &envtest.Environment{
		CRDDirectoryPaths:     []string{filepath.Join("..", "..", "config", "crd")},
		ErrorIfCRDPathMissing: true,
	}
	config, err := environment.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = environment.Stop() }()
	scheme := runtime.NewScheme()
	_ = clientgoscheme.AddToScheme(scheme)
	_ = v1alpha1.AddToScheme(scheme)
	manager, err := ctrl.NewManager(config, ctrl.Options{Scheme: scheme, Metrics: metricsserver.Options{BindAddress: "0"}})
	if err != nil {
		t.Fatal(err)
	}
	api := newFakeAPI()
	options := Options{Resync: time.Second, ClusterDomain: "cluster.local"}
	if err := (&GatewayServiceReconciler{Client: manager.GetClient(), API: api, Recorder: manager.GetEventRecorderFor("test"), Options: options}).SetupWithManager(manager); err != nil {
		t.Fatal(err)
	}
	if err := (&GatewayRouteReconciler{Client: manager.GetClient(), API: api, Recorder: manager.GetEventRecorderFor("test"), Options: options}).SetupWithManager(manager); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = manager.Start(ctx) }()
	k8s, err := client.New(config, client.Options{Scheme: scheme})
	if err != nil {
		t.Fatal(err)
	}
	get := func(name string, object client.Object) bool {
		return k8s.Get(ctx, types.NamespacedName{Namespace: "default", Name: name}, object) == nil
	}

	service := &v1alpha1.GatewayService{
		ObjectMeta: metav1.ObjectMeta{Name: "users", Namespace: "default"},
		Spec:       v1alpha1.GatewayServiceSpec{Targets: []v1alpha1.Target{{URL: "http://users.internal:8080"}}},
	}
	route := &v1alpha1.GatewayRoute{
		ObjectMeta: metav1.ObjectMeta{Name: "users-api", Namespace: "default"},
		Spec: v1alpha1.GatewayRouteSpec{
			Path:    "/users",
			Backend: v1alpha1.Backend{ServiceName: "users"},
			Plugins: []v1alpha1.Plugin{{Name: "cors", Config: &apiextensionsv1.JSON{Raw: []byte(`{"origins":["*"]}`)}}},
		},
	}
	// The route may arrive first; it waits for its backend.
	if err := k8s.Create(ctx, route); err != nil {
		t.Fatal(err)
	}
	eventually(t, "route waits for its backend", func() bool {
		var current v1alpha1.GatewayRoute
		_, reason := ready(current.Status.Conditions)
		return get("users-api", &current) && func() bool { _, reason = ready(current.Status.Conditions); return reason == "BackendNotReady" }()
	})
	if err := k8s.Create(ctx, service); err != nil {
		t.Fatal(err)
	}

	t.Run("creates the service and route in NovaGate", func(t *testing.T) {
		var current v1alpha1.GatewayRoute
		eventually(t, "route ready", func() bool {
			ok, _ := ready(current.Status.Conditions)
			return get("users-api", &current) && ok
		})
		routes, services, _ := api.snapshot()
		remote, ok := routes[current.Status.ID]
		if !ok {
			t.Fatalf("route %s missing remotely", current.Status.ID)
		}
		if remote.Method != "GET" || remote.PathPattern != "/users" || !remote.Enabled || remote.ServiceID != current.Status.ServiceID {
			t.Fatalf("unexpected remote route %+v", remote)
		}
		var plugins []map[string]any
		_ = json.Unmarshal(remote.Plugins, &plugins)
		if len(plugins) != 1 || plugins[0]["name"] != "cors" {
			t.Fatalf("unexpected plugins %s", remote.Plugins)
		}
		if services[current.Status.ServiceID].Name != "k8s:default/users" ||
			services[current.Status.ServiceID].Targets[0].Weight != 100 {
			t.Fatalf("unexpected remote service %+v", services[current.Status.ServiceID])
		}
	})

	t.Run("resyncs without writing when nothing changed", func(t *testing.T) {
		_, _, before := api.snapshot()
		time.Sleep(3 * time.Second)
		if _, _, after := api.snapshot(); after != before {
			t.Fatalf("resync wrote %d times", after-before)
		}
	})

	t.Run("applies spec changes and repairs out-of-band deletion", func(t *testing.T) {
		var current v1alpha1.GatewayRoute
		get("users-api", &current)
		current.Spec.Path = "/v2/users"
		limit := int64(50)
		current.Spec.RateLimitOverride = &limit
		if err := k8s.Update(ctx, &current); err != nil {
			t.Fatal(err)
		}
		id := current.Status.ID
		eventually(t, "remote updated", func() bool {
			routes, _, _ := api.snapshot()
			return routes[id].PathPattern == "/v2/users" && routes[id].RateLimitOverride != nil && *routes[id].RateLimitOverride == 50
		})
		_ = api.DeleteRoute(ctx, id)
		eventually(t, "route recreated by resync", func() bool {
			routes, _, _ := api.snapshot()
			for _, route := range routes {
				if route.PathPattern == "/v2/users" {
					return true
				}
			}
			return false
		})
	})

	t.Run("reports conflicts and API refusals without hot loops", func(t *testing.T) {
		twin := &v1alpha1.GatewayRoute{
			ObjectMeta: metav1.ObjectMeta{Name: "twin", Namespace: "default"},
			Spec:       v1alpha1.GatewayRouteSpec{Path: "/v2/users", Backend: v1alpha1.Backend{ServiceName: "users"}},
		}
		api.mu.Lock()
		api.refuse["/refused"] = true
		api.mu.Unlock()
		refused := &v1alpha1.GatewayRoute{
			ObjectMeta: metav1.ObjectMeta{Name: "refused", Namespace: "default"},
			Spec:       v1alpha1.GatewayRouteSpec{Path: "/refused", Backend: v1alpha1.Backend{ServiceName: "users"}},
		}
		for _, object := range []*v1alpha1.GatewayRoute{twin, refused} {
			if err := k8s.Create(ctx, object); err != nil {
				t.Fatal(err)
			}
		}
		eventually(t, "conflict reported", func() bool {
			var current v1alpha1.GatewayRoute
			_, reason := ready(current.Status.Conditions)
			return get("twin", &current) && func() bool { _, reason = ready(current.Status.Conditions); return reason == "Conflict" }()
		})
		eventually(t, "refusal reported", func() bool {
			var current v1alpha1.GatewayRoute
			if !get("refused", &current) {
				return false
			}
			condition := meta.FindStatusCondition(current.Status.Conditions, "Ready")
			return condition != nil && condition.Reason == "APIError" && condition.Message == "NovaGate refused the change (400): pathPattern is invalid"
		})
		// A refusal waits for the next resync (1 s here) instead of
		// controller-runtime's millisecond backoff.
		api.mu.Lock()
		before := api.refused
		api.mu.Unlock()
		time.Sleep(2 * time.Second)
		api.mu.Lock()
		attempts := api.refused - before
		api.mu.Unlock()
		if attempts > 4 {
			t.Fatalf("refused create retried %d times in 2 s", attempts)
		}
		for _, object := range []*v1alpha1.GatewayRoute{twin, refused} {
			_ = k8s.Delete(ctx, object)
		}
	})

	t.Run("generates and cleans up Kubernetes Service backends", func(t *testing.T) {
		kube := &v1alpha1.GatewayRoute{
			ObjectMeta: metav1.ObjectMeta{Name: "orders", Namespace: "default"},
			Spec: v1alpha1.GatewayRouteSpec{
				Method:  "post",
				Path:    "/orders",
				Backend: v1alpha1.Backend{Service: "orders-svc", Port: 8080},
			},
		}
		if err := k8s.Create(ctx, kube); err == nil {
			t.Fatal("lowercase method should be refused by the CRD schema")
		}
		kube.Spec.Method = "POST"
		if err := k8s.Create(ctx, kube); err != nil {
			t.Fatal(err)
		}
		var current v1alpha1.GatewayRoute
		eventually(t, "kubernetes backend ready", func() bool {
			ok, _ := ready(current.Status.Conditions)
			return get("orders", &current) && ok
		})
		_, services, _ := api.snapshot()
		generated := services[current.Status.ServiceID]
		if generated.Name != "k8s:default/svc/orders-svc:8080" || generated.Targets[0].URL != "http://orders-svc.default.svc.cluster.local:8080" {
			t.Fatalf("unexpected generated service %+v", generated)
		}
		if err := k8s.Delete(ctx, &current); err != nil {
			t.Fatal(err)
		}
		eventually(t, "generated service removed", func() bool {
			_, services, _ := api.snapshot()
			_, exists := services[current.Status.ServiceID]
			return !exists && !get("orders", &v1alpha1.GatewayRoute{})
		})
		// Invalid backends are refused by the CRD schema.
		bad := &v1alpha1.GatewayRoute{
			ObjectMeta: metav1.ObjectMeta{Name: "bad", Namespace: "default"},
			Spec:       v1alpha1.GatewayRouteSpec{Path: "/bad", Backend: v1alpha1.Backend{Service: "x"}},
		}
		if err := k8s.Create(ctx, bad); err == nil {
			t.Fatal("a Kubernetes service backend without a port should be refused")
		}
	})

	t.Run("keeps a GatewayService while routes use it, then cleans up", func(t *testing.T) {
		var currentService v1alpha1.GatewayService
		get("users", &currentService)
		serviceID := currentService.Status.ID
		if err := k8s.Delete(ctx, &currentService); err != nil {
			t.Fatal(err)
		}
		eventually(t, "service kept while in use", func() bool {
			var current v1alpha1.GatewayService
			if !get("users", &current) {
				return false
			}
			_, reason := ready(current.Status.Conditions)
			return reason == "InUse"
		})
		var currentRoute v1alpha1.GatewayRoute
		get("users-api", &currentRoute)
		if err := k8s.Delete(ctx, &currentRoute); err != nil {
			t.Fatal(err)
		}
		eventually(t, "route and service removed everywhere", func() bool {
			routes, services, _ := api.snapshot()
			_, serviceLeft := services[serviceID]
			return len(routes) == 0 && !serviceLeft &&
				!get("users-api", &v1alpha1.GatewayRoute{}) && !get("users", &v1alpha1.GatewayService{})
		})
	})
}
