package v1alpha1

import (
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Target is one upstream address of a GatewayService.
type Target struct {
	// +kubebuilder:validation:Pattern=`^https?://[^\s@]+$`
	// +kubebuilder:validation:MaxLength=2048
	URL string `json:"url"`
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=1000
	// +kubebuilder:default=100
	// +optional
	Weight int64 `json:"weight,omitempty"`
}

// GatewayServiceSpec describes a NovaGate service (an upstream).
type GatewayServiceSpec struct {
	// +kubebuilder:validation:MinItems=1
	// +kubebuilder:validation:MaxItems=64
	Targets []Target `json:"targets"`
	// +kubebuilder:validation:Pattern=`^/`
	// +kubebuilder:default=/health
	// +optional
	HealthCheckPath string `json:"healthCheckPath,omitempty"`
	// +kubebuilder:validation:Minimum=100
	// +kubebuilder:validation:Maximum=300000
	// +kubebuilder:default=10000
	// +optional
	TimeoutMs int64 `json:"timeoutMs,omitempty"`
	// +kubebuilder:validation:Enum=weighted-round-robin;least-connections
	// +kubebuilder:default=weighted-round-robin
	// +optional
	LoadBalancing string `json:"loadBalancing,omitempty"`
}

// GatewayStatus is common to both kinds.
type GatewayStatus struct {
	// ID of the object in NovaGate.
	// +optional
	ID string `json:"id,omitempty"`
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
	// +optional
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// GatewayService is a NovaGate upstream service managed from Kubernetes.
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=ngsvc
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="NovaGate ID",type=string,JSONPath=`.status.id`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type GatewayService struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              GatewayServiceSpec `json:"spec"`
	// +optional
	Status GatewayStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type GatewayServiceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []GatewayService `json:"items"`
}

// Backend names what a route forwards to: a GatewayService in the same
// namespace, or a Kubernetes Service and port reached through cluster DNS.
// +kubebuilder:validation:XValidation:rule="has(self.serviceName) != has(self.service)",message="set either serviceName or service and port"
// +kubebuilder:validation:XValidation:rule="!has(self.service) || has(self.port)",message="a Kubernetes service backend needs a port"
type Backend struct {
	// Name of a GatewayService in this namespace.
	// +optional
	ServiceName string `json:"serviceName,omitempty"`
	// Name of a Kubernetes Service in this namespace.
	// +optional
	Service string `json:"service,omitempty"`
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	// +optional
	Port int32 `json:"port,omitempty"`
	// +kubebuilder:validation:Enum=http;https
	// +kubebuilder:default=http
	// +optional
	Scheme string `json:"scheme,omitempty"`
}

// Plugin is one entry of a route's plugin pipeline, as in the dashboard.
type Plugin struct {
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=165
	Name string `json:"name"`
	// +kubebuilder:pruning:PreserveUnknownFields
	// +kubebuilder:validation:Type=object
	// +optional
	Config *apiextensionsv1.JSON `json:"config,omitempty"`
}

// GatewayRouteSpec describes a NovaGate route.
type GatewayRouteSpec struct {
	// +kubebuilder:validation:Enum=GET;POST;PUT;PATCH;DELETE;ANY
	// +kubebuilder:default=GET
	// +optional
	Method string `json:"method,omitempty"`
	// Path pattern, e.g. /users or /users/:id.
	// +kubebuilder:validation:Pattern=`^/`
	// +kubebuilder:validation:MaxLength=2048
	Path    string  `json:"path"`
	Backend Backend `json:"backend"`
	// +optional
	AuthRequired bool `json:"authRequired,omitempty"`
	// +kubebuilder:default=true
	// +optional
	Enabled *bool `json:"enabled,omitempty"`
	// Requests per window for this route, replacing the default limit.
	// +kubebuilder:validation:Minimum=1
	// +optional
	RateLimitOverride *int64 `json:"rateLimitOverride,omitempty"`
	// Runs in listed order.
	// +kubebuilder:validation:MaxItems=32
	// +optional
	Plugins []Plugin `json:"plugins,omitempty"`
}

// GatewayRoute is a NovaGate route managed from Kubernetes.
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=ngroute
// +kubebuilder:printcolumn:name="Method",type=string,JSONPath=`.spec.method`
// +kubebuilder:printcolumn:name="Path",type=string,JSONPath=`.spec.path`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type GatewayRoute struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              GatewayRouteSpec `json:"spec"`
	// +optional
	Status GatewayRouteStatus `json:"status,omitempty"`
}

// GatewayRouteStatus adds the NovaGate service the route forwards to.
type GatewayRouteStatus struct {
	GatewayStatus `json:",inline"`
	// +optional
	ServiceID string `json:"serviceId,omitempty"`
}

// +kubebuilder:object:root=true
type GatewayRouteList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []GatewayRoute `json:"items"`
}

func init() {
	SchemeBuilder.Register(&GatewayService{}, &GatewayServiceList{}, &GatewayRoute{}, &GatewayRouteList{})
}
