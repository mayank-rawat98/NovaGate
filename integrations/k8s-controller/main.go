// The NovaGate Kubernetes controller reconciles GatewayService and
// GatewayRoute resources into the NovaGate admin API, so routes can be
// managed with kubectl, Helm or GitOps instead of the dashboard.
package main

import (
	"flag"
	"os"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	v1alpha1 "github.com/mayank-rawat98/novagate/integrations/k8s-controller/api/v1alpha1"
	"github.com/mayank-rawat98/novagate/integrations/k8s-controller/internal/controller"
	"github.com/mayank-rawat98/novagate/integrations/k8s-controller/internal/novagate"
)

// +kubebuilder:rbac:groups=coordination.k8s.io,resources=leases,verbs=get;list;watch;create;update;patch;delete

func main() {
	var (
		metricsAddress string
		probeAddress   string
		leaderElection bool
		namespace      string
		resync         time.Duration
		clusterDomain  string
	)
	flag.StringVar(&metricsAddress, "metrics-bind-address", ":8080", "Prometheus metrics address; 0 disables")
	flag.StringVar(&probeAddress, "health-probe-bind-address", ":8081", "Health and readiness probe address")
	flag.BoolVar(&leaderElection, "leader-elect", false, "Run one active replica at a time")
	flag.StringVar(&namespace, "namespace", "", "Watch only this namespace (default: all)")
	flag.DurationVar(&resync, "resync", 10*time.Minute, "How often resources are compared with NovaGate to repair drift")
	flag.StringVar(&clusterDomain, "cluster-domain", "cluster.local", "DNS domain for Kubernetes Service backends")
	options := zap.Options{}
	options.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&options)))
	log := ctrl.Log.WithName("setup")

	// A controller with invalid credentials must not start half-working.
	api, err := novagate.New(os.Getenv("NOVAGATE_API_URL"), os.Getenv("NOVAGATE_TENANT_ID"), os.Getenv("NOVAGATE_TOKEN"))
	if err != nil {
		log.Error(err, "invalid NovaGate configuration")
		os.Exit(1)
	}
	if resync < 30*time.Second {
		log.Info("--resync is below 30s; using 30s")
		resync = 30 * time.Second
	}

	scheme := runtime.NewScheme()
	_ = clientgoscheme.AddToScheme(scheme)
	_ = v1alpha1.AddToScheme(scheme)
	managerOptions := ctrl.Options{
		Scheme:                 scheme,
		Metrics:                metricsserver.Options{BindAddress: metricsAddress},
		HealthProbeBindAddress: probeAddress,
		LeaderElection:         leaderElection,
		LeaderElectionID:       "novagate-controller.novagate.dev",
	}
	if namespace != "" {
		managerOptions.Cache = cache.Options{DefaultNamespaces: map[string]cache.Config{namespace: {}}}
	}
	manager, err := ctrl.NewManager(ctrl.GetConfigOrDie(), managerOptions)
	if err != nil {
		log.Error(err, "unable to start the manager")
		os.Exit(1)
	}
	shared := controller.Options{Resync: resync, ClusterDomain: clusterDomain}
	if err := (&controller.GatewayServiceReconciler{
		Client:   manager.GetClient(),
		API:      api,
		Recorder: manager.GetEventRecorderFor("novagate-controller"),
		Options:  shared,
	}).SetupWithManager(manager); err != nil {
		log.Error(err, "unable to set up the GatewayService controller")
		os.Exit(1)
	}
	if err := (&controller.GatewayRouteReconciler{
		Client:   manager.GetClient(),
		API:      api,
		Recorder: manager.GetEventRecorderFor("novagate-controller"),
		Options:  shared,
	}).SetupWithManager(manager); err != nil {
		log.Error(err, "unable to set up the GatewayRoute controller")
		os.Exit(1)
	}
	_ = manager.AddHealthzCheck("healthz", healthz.Ping)
	_ = manager.AddReadyzCheck("readyz", healthz.Ping)
	log.Info("starting", "tenant", api.Tenant(), "namespace", namespace, "resync", resync.String())
	if err := manager.Start(ctrl.SetupSignalHandler()); err != nil {
		log.Error(err, "manager stopped")
		os.Exit(1)
	}
}
