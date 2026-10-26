# NovaGate Kubernetes controller

Manage NovaGate routes and services as Kubernetes resources (issue #125).
`kubectl apply -f route.yaml` creates the route in NovaGate; your gateways
receive it through the control plane like any dashboard change.

The controller runs in your cluster and calls the NovaGate admin API with a
workspace automation token. It never touches live traffic: gateways keep
serving from their configuration if the controller or the cluster API is down.

## Resources (`novagate.dev/v1alpha1`)

```yaml
apiVersion: novagate.dev/v1alpha1
kind: GatewayService
metadata:
  name: users
spec:
  targets:
    - url: http://users.default.svc.cluster.local:8080
      weight: 100
  healthCheckPath: /health # default
  timeoutMs: 10000 # default
  loadBalancing: weighted-round-robin # or least-connections
---
apiVersion: novagate.dev/v1alpha1
kind: GatewayRoute
metadata:
  name: users-api
spec:
  method: GET # GET, POST, PUT, PATCH, DELETE or ANY
  path: /users
  backend:
    serviceName: users # a GatewayService in this namespace
  authRequired: false
  enabled: true
  rateLimitOverride: 200 # optional
  plugins: # same names and configuration as the dashboard
    - name: cors
      config:
        origins: ['*']
```

A route can also forward straight to a Kubernetes Service:
`backend: { service: orders, port: 8080, scheme: http }`. The controller then
manages a NovaGate service named `k8s:<namespace>/svc/orders:8080` with the
target `http://orders.<namespace>.svc.cluster.local:8080`, which assumes the
gateway runs in the cluster. It removes that service when no route uses it.

Plugins include `wasm:<name>` WebAssembly plugins installed in the Plugin
marketplace, and third-party plugins by package name.

`kubectl get gatewayroutes` shows method, path and readiness. `status.id` is the
NovaGate ID, and the `Ready` condition explains any problem, such as
`BackendNotReady`, `Conflict`, `APIError` with NovaGate's message, or `InUse`.
Events record creates and updates.

## Behaviour

- **Writes only on change:** NovaGate services are named `k8s:<namespace>/<name>`. Each reconcile compares the resource with NovaGate and writes only when they differ, so the periodic resync (`--resync`, default 10 minutes) never pushes configuration needlessly. It also repairs edits made in the dashboard: Kubernetes is the source of truth for these objects.
- **Adoption and conflicts:** an existing NovaGate route with the same method and path is adopted. If another `GatewayRoute` already manages it, the new one reports `Conflict` instead.
- **Deletion:** deleting a `GatewayRoute` soft-deletes the NovaGate route through a finalizer. A `GatewayService` used by a route is kept (`InUse`) until the route is deleted or repointed.
- **Retries:** errors NovaGate rejects (4xx other than 429) wait for the next resync instead of retrying in a tight loop. Other errors back off.
- **Not supported:** the roadmap's `host` field, because NovaGate routes match on method and path.

## Install

```sh
kubectl apply -f config/crd
kubectl apply -f config/rbac/role.yaml
kubectl create namespace novagate-system
kubectl -n novagate-system create secret generic novagate-api \
  --from-literal=NOVAGATE_API_URL=https://admin.example.com/api \
  --from-literal=NOVAGATE_TENANT_ID=<workspace id> \
  --from-literal=NOVAGATE_TOKEN=ngat_...   # scopes: routes:write, services:write
kubectl apply -f config/manager/controller.yaml
```

Build the image from this directory with the `Dockerfile` (distroless,
non-root). With `--leader-elect`, the Deployment runs two replicas with one
active. Other flags:

- `--namespace` watches one namespace;
- `--cluster-domain` sets the DNS domain for Service backends;
- `--resync` sets the drift-repair interval.

Probes listen on `:8081`, and metrics on `:8080` (`0` disables them).

The controller refuses to start without a valid HTTPS API URL (HTTP only for
loopback), a workspace UUID and an automation token.

## Development

```sh
npm exec nx run k8s-controller:generate   # deepcopy, CRDs and RBAC (controller-gen)
npm exec nx run k8s-controller:test       # envtest suite needs KUBEBUILDER_ASSETS
npm exec nx run k8s-controller:e2e        # real admin API, control plane and gateway
```

`KUBEBUILDER_ASSETS` is a directory holding `etcd`, `kube-apiserver` and
`kubectl`. Fill it with
`go run sigs.k8s.io/controller-runtime/tools/setup-envtest@release-0.19 use 1.31.x -p path`,
or download `kube-apiserver` and `kubectl` from `dl.k8s.io` and build `etcd`
3.5 from its Go module. Without the variable, the envtest suite is skipped.

The E2E starts a real kube-apiserver and etcd, installs the CRDs with
`kubectl`, runs the built controller, and then:

1. applies `examples/route.yaml` (with a `GatewayService` pointing at a test upstream);
2. checks the route in the admin API and traffic through a real gateway;
3. edits the path with `kubectl patch`;
4. deletes the route with `kubectl delete` and checks the soft delete in PostgreSQL.
