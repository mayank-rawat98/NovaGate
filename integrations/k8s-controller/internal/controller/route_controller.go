package controller

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	v1alpha1 "github.com/mayank-rawat98/novagate/integrations/k8s-controller/api/v1alpha1"
	"github.com/mayank-rawat98/novagate/integrations/k8s-controller/internal/novagate"
)

// GatewayRouteReconciler keeps a NovaGate route per GatewayRoute.
type GatewayRouteReconciler struct {
	client.Client
	API      API
	Recorder record.EventRecorder
	Options  Options
}

// +kubebuilder:rbac:groups=novagate.dev,resources=gatewayroutes,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=novagate.dev,resources=gatewayroutes/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=novagate.dev,resources=gatewayroutes/finalizers,verbs=update

// kubernetesBackend is the managed NovaGate service for a Kubernetes Service.
func (r *GatewayRouteReconciler) kubernetesBackend(namespace string, backend v1alpha1.Backend) novagate.Service {
	scheme := backend.Scheme
	if scheme == "" {
		scheme = "http"
	}
	return novagate.Service{
		Name: fmt.Sprintf("%s%s/svc/%s:%d", ManagedPrefix, namespace, backend.Service, backend.Port),
		Targets: []novagate.Target{{
			URL:    fmt.Sprintf("%s://%s.%s.svc.%s:%d", scheme, backend.Service, namespace, r.Options.ClusterDomain, backend.Port),
			Weight: 100,
		}},
		HealthCheckPath: "/health",
		TimeoutMs:       10000,
		LoadBalancing:   "weighted-round-robin",
	}
}

func desiredRoute(object *v1alpha1.GatewayRoute, serviceID string) (novagate.Route, error) {
	type entry struct {
		Name   string          `json:"name"`
		Config json.RawMessage `json:"config"`
	}
	plugins := make([]entry, 0, len(object.Spec.Plugins))
	for _, plugin := range object.Spec.Plugins {
		config := json.RawMessage(`{}`)
		if plugin.Config != nil && len(plugin.Config.Raw) > 0 {
			config = plugin.Config.Raw
		}
		plugins = append(plugins, entry{Name: plugin.Name, Config: config})
	}
	encoded, err := json.Marshal(plugins)
	if err != nil {
		return novagate.Route{}, err
	}
	method := strings.ToUpper(object.Spec.Method)
	if method == "" {
		method = "GET"
	}
	enabled := object.Spec.Enabled == nil || *object.Spec.Enabled
	return novagate.Route{
		Method:            method,
		PathPattern:       object.Spec.Path,
		ServiceID:         serviceID,
		AuthRequired:      object.Spec.AuthRequired,
		Enabled:           enabled,
		RateLimitOverride: object.Spec.RateLimitOverride,
		Plugins:           encoded,
	}, nil
}

func (r *GatewayRouteReconciler) fail(ctx context.Context, object *v1alpha1.GatewayRoute, reason string, err error) (ctrl.Result, error) {
	setReady(&object.Status.Conditions, object.Generation, false, reason, describe(err))
	_ = r.Status().Update(ctx, object)
	r.Recorder.Event(object, corev1.EventTypeWarning, reason, describe(err))
	if permanent(err) {
		return ctrl.Result{RequeueAfter: r.Options.Resync}, nil
	}
	return ctrl.Result{}, err
}

func (r *GatewayRouteReconciler) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
	var object v1alpha1.GatewayRoute
	if err := r.Get(ctx, request.NamespacedName, &object); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !object.DeletionTimestamp.IsZero() {
		return r.delete(ctx, &object)
	}
	if controllerutil.AddFinalizer(&object, Finalizer) {
		if err := r.Update(ctx, &object); err != nil {
			return ctrl.Result{}, err
		}
	}

	// Resolve the backend to a NovaGate service ID.
	var serviceID string
	backend := object.Spec.Backend
	if backend.ServiceName != "" {
		var service v1alpha1.GatewayService
		err := r.Get(ctx, types.NamespacedName{Namespace: object.Namespace, Name: backend.ServiceName}, &service)
		if err != nil || service.Status.ID == "" || !service.DeletionTimestamp.IsZero() {
			if err != nil && !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
			setReady(&object.Status.Conditions, object.Generation, false, "BackendNotReady",
				"GatewayService "+backend.ServiceName+" does not exist or is not synced yet")
			_ = r.Status().Update(ctx, &object)
			return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
		}
		serviceID = service.Status.ID
	} else {
		id, _, err := ensureService(ctx, r.API, "", r.kubernetesBackend(object.Namespace, backend))
		if err != nil {
			return r.fail(ctx, &object, "APIError", err)
		}
		serviceID = id
	}

	desired, err := desiredRoute(&object, serviceID)
	if err != nil {
		return r.fail(ctx, &object, "InvalidSpec", err)
	}
	routes, err := r.API.Routes(ctx)
	if err != nil {
		return r.fail(ctx, &object, "APIError", err)
	}
	var current *novagate.Route
	for i := range routes {
		if object.Status.ID != "" && routes[i].ID == object.Status.ID {
			current = &routes[i]
			break
		}
	}
	if current == nil {
		// Adopt a route with the same method and path, unless another
		// GatewayRoute already manages it.
		for i := range routes {
			if routes[i].Method == desired.Method && routes[i].PathPattern == desired.PathPattern {
				owner, err := r.ownerOf(ctx, routes[i].ID, &object)
				if err != nil {
					return ctrl.Result{}, err
				}
				if owner != "" {
					setReady(&object.Status.Conditions, object.Generation, false, "Conflict",
						fmt.Sprintf("%s %s is already managed by GatewayRoute %s", desired.Method, desired.PathPattern, owner))
					_ = r.Status().Update(ctx, &object)
					return ctrl.Result{RequeueAfter: r.Options.Resync}, nil
				}
				current = &routes[i]
				break
			}
		}
	}

	id := ""
	switch {
	case current == nil:
		created, err := r.API.CreateRoute(ctx, desired)
		if err != nil {
			return r.fail(ctx, &object, "APIError", err)
		}
		id = created.ID
		r.Recorder.Event(&object, corev1.EventTypeNormal, "Created", "NovaGate route "+id+" created")
	case sameRoute(*current, desired):
		id = current.ID
	default:
		if _, err := r.API.UpdateRoute(ctx, current.ID, desired); err != nil {
			return r.fail(ctx, &object, "APIError", err)
		}
		id = current.ID
		r.Recorder.Event(&object, corev1.EventTypeNormal, "Synced", "NovaGate route "+id+" updated")
	}
	object.Status.ID = id
	object.Status.ServiceID = serviceID
	object.Status.ObservedGeneration = object.Generation
	setReady(&object.Status.Conditions, object.Generation, true, "Synced",
		fmt.Sprintf("NovaGate route %s: %s %s", id, desired.Method, desired.PathPattern))
	if err := r.Status().Update(ctx, &object); err != nil && !apierrors.IsConflict(err) {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: r.Options.Resync}, nil
}

// ownerOf names another GatewayRoute that records this remote route ID.
func (r *GatewayRouteReconciler) ownerOf(ctx context.Context, id string, self *v1alpha1.GatewayRoute) (string, error) {
	var routes v1alpha1.GatewayRouteList
	if err := r.List(ctx, &routes); err != nil {
		return "", err
	}
	for _, route := range routes.Items {
		if route.Status.ID == id && route.UID != self.UID {
			return route.Namespace + "/" + route.Name, nil
		}
	}
	return "", nil
}

func (r *GatewayRouteReconciler) delete(ctx context.Context, object *v1alpha1.GatewayRoute) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(object, Finalizer) {
		return ctrl.Result{}, nil
	}
	if object.Status.ID != "" {
		if err := r.API.DeleteRoute(ctx, object.Status.ID); err != nil {
			return r.fail(ctx, object, "APIError", err)
		}
	}
	// A generated Kubernetes Service backend goes when no route uses it.
	backend := object.Spec.Backend
	if backend.Service != "" && object.Status.ServiceID != "" {
		var routes v1alpha1.GatewayRouteList
		if err := r.List(ctx, &routes, client.InNamespace(object.Namespace)); err != nil {
			return ctrl.Result{}, err
		}
		used := false
		for _, route := range routes.Items {
			if route.UID != object.UID && route.Spec.Backend.Service == backend.Service && route.Spec.Backend.Port == backend.Port {
				used = true
			}
		}
		if !used {
			if err := r.API.DeleteService(ctx, object.Status.ServiceID); err != nil {
				return r.fail(ctx, object, "APIError", err)
			}
		}
	}
	controllerutil.RemoveFinalizer(object, Finalizer)
	return ctrl.Result{}, r.Update(ctx, object)
}

func (r *GatewayRouteReconciler) SetupWithManager(manager ctrl.Manager) error {
	// A GatewayService becoming ready (or changing ID) re-reconciles routes
	// that point at it.
	routesFor := handler.EnqueueRequestsFromMapFunc(func(ctx context.Context, object client.Object) []reconcile.Request {
		var routes v1alpha1.GatewayRouteList
		if err := r.List(ctx, &routes, client.InNamespace(object.GetNamespace())); err != nil {
			return nil
		}
		var requests []reconcile.Request
		for _, route := range routes.Items {
			if route.Spec.Backend.ServiceName == object.GetName() {
				requests = append(requests, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: route.Namespace, Name: route.Name}})
			}
		}
		return requests
	})
	return ctrl.NewControllerManagedBy(manager).
		For(&v1alpha1.GatewayRoute{}).
		Watches(&v1alpha1.GatewayService{}, routesFor).
		Complete(r)
}
