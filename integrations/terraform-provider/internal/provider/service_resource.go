package provider

import (
	"context"
	"errors"
	"net/http"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/mayank-rawat98/novagate/integrations/terraform-provider/internal/client"
)

var (
	_ resource.Resource                = &serviceResource{}
	_ resource.ResourceWithImportState = &serviceResource{}
)

type serviceResource struct{ client *client.Client }

type targetModel struct {
	URL    types.String `tfsdk:"url"`
	Weight types.Int64  `tfsdk:"weight"`
}

type serviceModel struct {
	ID                    types.String  `tfsdk:"id"`
	Name                  types.String  `tfsdk:"name"`
	Targets               []targetModel `tfsdk:"targets"`
	HealthCheckPath       types.String  `tfsdk:"health_check_path"`
	TimeoutMs             types.Int64   `tfsdk:"timeout_ms"`
	HealthCheckIntervalMs types.Int64   `tfsdk:"health_check_interval_ms"`
	HealthCheckProtocol   types.String  `tfsdk:"health_check_protocol"`
	HealthCheckService    types.String  `tfsdk:"health_check_service"`
	UnhealthyFallback     types.Bool    `tfsdk:"unhealthy_fallback"`
	H2                    types.Bool    `tfsdk:"h2"`
	SupportsWebSocket     types.Bool    `tfsdk:"supports_websocket"`
	LoadBalancing         types.String  `tfsdk:"load_balancing"`
}

func NewServiceResource() resource.Resource { return &serviceResource{} }

func (r *serviceResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_service"
}

func (r *serviceResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "An upstream service with weighted targets and health checks. Destroy soft-deletes it. Requires the services:write scope.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{Required: true, Validators: []validator.String{stringvalidator.LengthBetween(1, 128)}},
			"targets": schema.ListNestedAttribute{
				Required:   true,
				Validators: []validator.List{listvalidator.SizeBetween(1, 256)},
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"url": schema.StringAttribute{Required: true, Description: "HTTP or HTTPS URL without credentials."},
						"weight": schema.Int64Attribute{
							Optional: true, Computed: true, Default: int64default.StaticInt64(100),
							Validators: []validator.Int64{int64validator.Between(1, 100)},
						},
					},
				},
			},
			"health_check_path": schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString("/health")},
			"timeout_ms": schema.Int64Attribute{
				Optional: true, Computed: true, Default: int64default.StaticInt64(10000),
				Validators: []validator.Int64{int64validator.Between(100, 3600000)},
			},
			"health_check_interval_ms": schema.Int64Attribute{
				Optional: true, Computed: true, Default: int64default.StaticInt64(10000),
				Validators: []validator.Int64{int64validator.Between(1000, 60000)},
			},
			"health_check_protocol": schema.StringAttribute{
				Optional: true, Computed: true, Default: stringdefault.StaticString("http"),
				Validators: []validator.String{stringvalidator.OneOf("http", "grpc")},
			},
			"health_check_service": schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString("")},
			"unhealthy_fallback":   schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(false)},
			"h2":                   schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(false)},
			"supports_websocket":   schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(false)},
			"load_balancing": schema.StringAttribute{
				Optional: true, Computed: true, Default: stringdefault.StaticString("weighted-round-robin"),
				Validators: []validator.String{stringvalidator.OneOf("weighted-round-robin", "least-connections")},
			},
		},
	}
}

func (r *serviceResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (m *serviceModel) request() client.Service {
	targets := make([]client.Target, len(m.Targets))
	for index, target := range m.Targets {
		targets[index] = client.Target{URL: target.URL.ValueString(), Weight: target.Weight.ValueInt64()}
	}
	return client.Service{
		Name:                  m.Name.ValueString(),
		Targets:               targets,
		HealthCheckPath:       m.HealthCheckPath.ValueString(),
		TimeoutMs:             m.TimeoutMs.ValueInt64(),
		HealthCheckIntervalMs: m.HealthCheckIntervalMs.ValueInt64(),
		HealthCheckProtocol:   m.HealthCheckProtocol.ValueString(),
		HealthCheckService:    m.HealthCheckService.ValueString(),
		UnhealthyFallback:     m.UnhealthyFallback.ValueBool(),
		H2:                    m.H2.ValueBool(),
		SupportsWebSocket:     m.SupportsWebSocket.ValueBool(),
		LoadBalancing:         m.LoadBalancing.ValueString(),
	}
}

func (m *serviceModel) refresh(service *client.Service) {
	m.ID = types.StringValue(service.ID)
	m.Name = types.StringValue(service.Name)
	m.Targets = make([]targetModel, len(service.Targets))
	for index, target := range service.Targets {
		m.Targets[index] = targetModel{URL: types.StringValue(target.URL), Weight: types.Int64Value(target.Weight)}
	}
	m.HealthCheckPath = types.StringValue(service.HealthCheckPath)
	m.TimeoutMs = types.Int64Value(service.TimeoutMs)
	m.HealthCheckIntervalMs = types.Int64Value(service.HealthCheckIntervalMs)
	m.HealthCheckProtocol = types.StringValue(service.HealthCheckProtocol)
	m.HealthCheckService = types.StringValue(service.HealthCheckService)
	m.UnhealthyFallback = types.BoolValue(service.UnhealthyFallback)
	m.H2 = types.BoolValue(service.H2)
	m.SupportsWebSocket = types.BoolValue(service.SupportsWebSocket)
	m.LoadBalancing = types.StringValue(service.LoadBalancing)
}

func (r *serviceResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan serviceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var created client.Service
	if err := r.client.Do(ctx, http.MethodPost, "/services", plan.request(), &created); err != nil {
		addAPIError(&resp.Diagnostics, "Creating NovaGate service failed", err)
		return
	}
	plan.refresh(&created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *serviceResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state serviceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	service, err := r.client.Service(ctx, state.ID.ValueString())
	if errors.Is(err, client.ErrNotFound) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		addAPIError(&resp.Diagnostics, "Reading NovaGate service failed", err)
		return
	}
	state.refresh(service)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *serviceResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state serviceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var updated client.Service
	if err := r.client.Do(ctx, http.MethodPut, "/services/"+state.ID.ValueString(), plan.request(), &updated); err != nil {
		addAPIError(&resp.Diagnostics, "Updating NovaGate service failed", err)
		return
	}
	plan.refresh(&updated)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *serviceResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state serviceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.Do(ctx, http.MethodDelete, "/services/"+state.ID.ValueString(), nil, nil); err != nil && !errors.Is(err, client.ErrNotFound) {
		addAPIError(&resp.Diagnostics, "Deleting NovaGate service failed", err)
	}
}

func (r *serviceResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
