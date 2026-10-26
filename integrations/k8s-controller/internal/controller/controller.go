// Package controller reconciles GatewayService and GatewayRoute resources
// into NovaGate services and routes through the admin API.
package controller

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/mayank-rawat98/novagate/integrations/k8s-controller/internal/novagate"
)

// Finalizer lets the controller remove remote objects before Kubernetes
// forgets the resource.
const Finalizer = "novagate.dev/finalizer"

// ManagedPrefix marks NovaGate service names the controller owns.
const ManagedPrefix = "k8s:"

// API is the part of the admin API the controller uses.
type API interface {
	Routes(ctx context.Context) ([]novagate.Route, error)
	Services(ctx context.Context) ([]novagate.Service, error)
	CreateRoute(ctx context.Context, route novagate.Route) (novagate.Route, error)
	UpdateRoute(ctx context.Context, id string, route novagate.Route) (novagate.Route, error)
	DeleteRoute(ctx context.Context, id string) error
	CreateService(ctx context.Context, service novagate.Service) (novagate.Service, error)
	UpdateService(ctx context.Context, id string, service novagate.Service) (novagate.Service, error)
	DeleteService(ctx context.Context, id string) error
}

// Options shared by both reconcilers.
type Options struct {
	// Resync is how often unchanged resources are compared with NovaGate,
	// repairing changes made in the dashboard.
	Resync time.Duration
	// ClusterDomain forms Kubernetes Service backend addresses.
	ClusterDomain string
}

// ensureService creates, adopts or updates a NovaGate service by ID or name,
// writing only when something differs so resyncs never push configuration.
func ensureService(ctx context.Context, api API, id string, desired novagate.Service) (string, bool, error) {
	services, err := api.Services(ctx)
	if err != nil {
		return "", false, err
	}
	// By recorded ID first, then adopt one with the managed name.
	var current *novagate.Service
	for i := range services {
		if id != "" && services[i].ID == id {
			current = &services[i]
			break
		}
	}
	for i := range services {
		if current == nil && services[i].Name == desired.Name {
			current = &services[i]
		}
	}
	if current == nil {
		created, err := api.CreateService(ctx, desired)
		return created.ID, true, err
	}
	if sameService(*current, desired) {
		return current.ID, false, nil
	}
	_, err = api.UpdateService(ctx, current.ID, desired)
	return current.ID, true, err
}

func sameService(current, desired novagate.Service) bool {
	return current.Name == desired.Name &&
		reflect.DeepEqual(current.Targets, desired.Targets) &&
		current.HealthCheckPath == desired.HealthCheckPath &&
		current.TimeoutMs == desired.TimeoutMs &&
		current.LoadBalancing == desired.LoadBalancing
}

func sameRoute(current, desired novagate.Route) bool {
	return current.Method == desired.Method &&
		current.PathPattern == desired.PathPattern &&
		current.ServiceID == desired.ServiceID &&
		current.AuthRequired == desired.AuthRequired &&
		current.Enabled == desired.Enabled &&
		reflect.DeepEqual(current.RateLimitOverride, desired.RateLimitOverride) &&
		samePlugins(current.Plugins, desired.Plugins)
}

// samePlugins compares JSON values; null and [] are both "no plugins".
func samePlugins(a, b json.RawMessage) bool {
	decode := func(raw json.RawMessage) any {
		var value any
		if len(raw) == 0 || json.Unmarshal(raw, &value) != nil || value == nil {
			return []any{}
		}
		return value
	}
	return reflect.DeepEqual(decode(a), decode(b))
}

// setReady records the outcome as the Ready condition.
func setReady(conditions *[]metav1.Condition, generation int64, ok bool, reason, message string) {
	status := metav1.ConditionTrue
	if !ok {
		status = metav1.ConditionFalse
	}
	if len(message) > 1024 {
		message = message[:1024]
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type:               "Ready",
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: generation,
	})
}

// permanent reports API errors that retrying soon will not fix.
func permanent(err error) bool {
	var apiError *novagate.APIError
	return errors.As(err, &apiError) && apiError.Status >= 400 && apiError.Status < 500 && apiError.Status != 429
}

func describe(err error) string {
	var apiError *novagate.APIError
	if errors.As(err, &apiError) {
		return fmt.Sprintf("NovaGate refused the change (%d): %s", apiError.Status, apiError.Message)
	}
	return err.Error()
}
