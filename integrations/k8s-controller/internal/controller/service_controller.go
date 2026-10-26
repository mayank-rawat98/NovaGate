package controller

import (
	"context"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	v1alpha1 "github.com/mayank-rawat98/novagate/integrations/k8s-controller/api/v1alpha1"
	"github.com/mayank-rawat98/novagate/integrations/k8s-controller/internal/novagate"
)

// GatewayServiceReconciler keeps a NovaGate service per GatewayService.
type GatewayServiceReconciler struct {
	client.Client
	API      API
	Recorder record.EventRecorder
	Options  Options
}

// +kubebuilder:rbac:groups=novagate.dev,resources=gatewayservices,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=novagate.dev,resources=gatewayservices/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=novagate.dev,resources=gatewayservices/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch

func serviceName(namespace, name string) string {
	return ManagedPrefix + namespace + "/" + name
}

func desiredService(object *v1alpha1.GatewayService) novagate.Service {
	targets := make([]novagate.Target, 0, len(object.Spec.Targets))
	for _, target := range object.Spec.Targets {
		weight := target.Weight
		if weight == 0 {
			weight = 100
		}
		targets = append(targets, novagate.Target{URL: target.URL, Weight: weight})
	}
	service := novagate.Service{
		Name:            serviceName(object.Namespace, object.Name),
		Targets:         targets,
		HealthCheckPath: object.Spec.HealthCheckPath,
		TimeoutMs:       object.Spec.TimeoutMs,
		LoadBalancing:   object.Spec.LoadBalancing,
	}
	if service.HealthCheckPath == "" {
		service.HealthCheckPath = "/health"
	}
	if service.TimeoutMs == 0 {
		service.TimeoutMs = 10000
	}
	if service.LoadBalancing == "" {
		service.LoadBalancing = "weighted-round-robin"
	}
	return service
}

func (r *GatewayServiceReconciler) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
	var object v1alpha1.GatewayService
	if err := r.Get(ctx, request.NamespacedName, &object); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if !object.DeletionTimestamp.IsZero() {
		if !controllerutil.ContainsFinalizer(&object, Finalizer) {
			return ctrl.Result{}, nil
		}
		// Routes using this service would lose their upstream.
		var routes v1alpha1.GatewayRouteList
		if err := r.List(ctx, &routes, client.InNamespace(object.Namespace)); err != nil {
			return ctrl.Result{}, err
		}
		for _, route := range routes.Items {
			if route.Spec.Backend.ServiceName == object.Name && route.DeletionTimestamp.IsZero() {
				setReady(&object.Status.Conditions, object.Generation, false, "InUse",
					"GatewayRoute "+route.Name+" still uses this service; delete or repoint it first")
				_ = r.Status().Update(ctx, &object)
				return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
			}
		}
		if object.Status.ID != "" {
			if err := r.API.DeleteService(ctx, object.Status.ID); err != nil {
				return ctrl.Result{}, err
			}
		}
		controllerutil.RemoveFinalizer(&object, Finalizer)
		return ctrl.Result{}, r.Update(ctx, &object)
	}

	if controllerutil.AddFinalizer(&object, Finalizer) {
		if err := r.Update(ctx, &object); err != nil {
			return ctrl.Result{}, err
		}
	}

	id, changed, err := ensureService(ctx, r.API, object.Status.ID, desiredService(&object))
	if err != nil {
		setReady(&object.Status.Conditions, object.Generation, false, "APIError", describe(err))
		_ = r.Status().Update(ctx, &object)
		r.Recorder.Event(&object, corev1.EventTypeWarning, "SyncFailed", describe(err))
		if permanent(err) {
			return ctrl.Result{RequeueAfter: r.Options.Resync}, nil
		}
		return ctrl.Result{}, err
	}
	if changed {
		r.Recorder.Event(&object, corev1.EventTypeNormal, "Synced", "NovaGate service "+id+" updated")
	}
	object.Status.ID = id
	object.Status.ObservedGeneration = object.Generation
	setReady(&object.Status.Conditions, object.Generation, true, "Synced", "NovaGate service "+id)
	if err := r.Status().Update(ctx, &object); err != nil && !apierrors.IsConflict(err) {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: r.Options.Resync}, nil
}

func (r *GatewayServiceReconciler) SetupWithManager(manager ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(manager).For(&v1alpha1.GatewayService{}).Complete(r)
}
