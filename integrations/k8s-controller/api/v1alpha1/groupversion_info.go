// Package v1alpha1 holds the novagate.dev/v1alpha1 API: Kubernetes resources
// that the controller reconciles into NovaGate services and routes.
// +kubebuilder:object:generate=true
// +groupName=novagate.dev
package v1alpha1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
	// GroupVersion is the API group and version of these resources.
	GroupVersion = schema.GroupVersion{Group: "novagate.dev", Version: "v1alpha1"}
	// SchemeBuilder registers the types with a runtime scheme.
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}
	// AddToScheme adds the types to a scheme.
	AddToScheme = SchemeBuilder.AddToScheme
)
