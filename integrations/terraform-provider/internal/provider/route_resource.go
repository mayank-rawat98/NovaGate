package provider

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/hashicorp/terraform-plugin-framework-jsontypes/jsontypes"
	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/mayank-rawat98/novagate/integrations/terraform-provider/internal/client"
)

var (
	_ resource.Resource                = &routeResource{}
	_ resource.ResourceWithImportState = &routeResource{}
)

type routeResource struct{ client *client.Client }

type retryModel struct {
	Attempts types.Int64    `tfsdk:"attempts"`
	On       []types.Int64  `tfsdk:"on"`
	Methods  []types.String `tfsdk:"methods"`
}

type portalModel struct {
	Visible     types.Bool   `tfsdk:"visible"`
	Summary     types.String `tfsdk:"summary"`
	Description types.String `tfsdk:"description"`
}

type routeModel struct {
	ID                types.String         `tfsdk:"id"`
	Method            types.String         `tfsdk:"method"`
	PathPattern       types.String         `tfsdk:"path_pattern"`
	ServiceID         types.String         `tfsdk:"service_id"`
	AuthRequired      types.Bool           `tfsdk:"auth_required"`
	Enabled           types.Bool           `tfsdk:"enabled"`
	RateLimitOverride types.Int64          `tfsdk:"rate_limit_override"`
	Retry             *retryModel          `tfsdk:"retry"`
	Plugins           jsontypes.Normalized `tfsdk:"plugins"`
	Portal            *portalModel         `tfsdk:"portal"`
}

func NewRouteResource() resource.Resource { return &routeResource{} }

func (r *routeResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_route"
}

var routeMethods = []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"}

func (r *routeResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A gateway route. Destroy soft-deletes it. Requires the routes:write scope.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"method": schema.StringAttribute{Required: true, Validators: []validator.String{stringvalidator.OneOf(routeMethods...)}},
			"path_pattern": schema.StringAttribute{
				Required:    true,
				Description: "Path prefix or pattern such as /users or /users/:id.",
				Validators:  []validator.String{stringvalidator.LengthBetween(1, 1024)},
			},
			"service_id":    schema.StringAttribute{Required: true},
			"auth_required": schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(false)},
			"enabled":       schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(true)},
			"rate_limit_override": schema.Int64Attribute{
				Optional:   true,
				Validators: []validator.Int64{int64validator.Between(1, 1000000000)},
			},
			"retry": schema.SingleNestedAttribute{
				Optional: true,
				Attributes: map[string]schema.Attribute{
					"attempts": schema.Int64Attribute{Required: true, Validators: []validator.Int64{int64validator.Between(0, 5)}},
					"on":       schema.ListAttribute{Required: true, ElementType: types.Int64Type, Description: "Upstream status codes that trigger a retry."},
					"methods":  schema.ListAttribute{Required: true, ElementType: types.StringType},
				},
			},
			"plugins": schema.StringAttribute{
				Optional:    true,
				Sensitive:   true,
				CustomType:  jsontypes.NormalizedType{},
				Description: "Ordered plugin pipeline as JSON, for example jsonencode([{ name = \"cors\", config = { origins = [\"https://app.example.com\"] } }]). Sensitive because plugin configuration can contain credentials.",
			},
			"portal": schema.SingleNestedAttribute{
				Optional:    true,
				Description: "Developer portal publication.",
				Attributes: map[string]schema.Attribute{
					"visible":     schema.BoolAttribute{Required: true},
					"summary":     schema.StringAttribute{Optional: true, Validators: []validator.String{stringvalidator.LengthBetween(1, 160)}},
					"description": schema.StringAttribute{Optional: true, Validators: []validator.String{stringvalidator.LengthBetween(1, 4000)}},
				},
			},
		},
	}
}

func (r *routeResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (m *routeModel) request() client.Route {
	route := client.Route{
		Method:       m.Method.ValueString(),
		PathPattern:  m.PathPattern.ValueString(),
		ServiceID:    m.ServiceID.ValueString(),
		AuthRequired: m.AuthRequired.ValueBool(),
		Enabled:      m.Enabled.ValueBool(),
		// Explicit nulls clear optional settings on update.
		Plugins: json.RawMessage("null"),
	}
	if !m.RateLimitOverride.IsNull() {
		value := m.RateLimitOverride.ValueInt64()
		route.RateLimitOverride = &value
	}
	if m.Retry != nil {
		retry := client.Retry{Attempts: m.Retry.Attempts.ValueInt64(), On: []int64{}, Methods: []string{}}
		for _, code := range m.Retry.On {
			retry.On = append(retry.On, code.ValueInt64())
		}
		for _, method := range m.Retry.Methods {
			retry.Methods = append(retry.Methods, method.ValueString())
		}
		route.Retry = &retry
	}
	if !m.Plugins.IsNull() {
		route.Plugins = json.RawMessage(m.Plugins.ValueString())
	}
	if m.Portal != nil {
		route.Portal = &client.Portal{
			Visible:     m.Portal.Visible.ValueBool(),
			Summary:     m.Portal.Summary.ValueString(),
			Description: m.Portal.Description.ValueString(),
		}
	}
	return route
}

func optionalString(value string) types.String {
	if value == "" {
		return types.StringNull()
	}
	return types.StringValue(value)
}

func (m *routeModel) refresh(route *client.Route) {
	m.ID = types.StringValue(route.ID)
	m.Method = types.StringValue(route.Method)
	m.PathPattern = types.StringValue(route.PathPattern)
	m.ServiceID = types.StringValue(route.ServiceID)
	m.AuthRequired = types.BoolValue(route.AuthRequired)
	m.Enabled = types.BoolValue(route.Enabled)
	if route.RateLimitOverride == nil {
		m.RateLimitOverride = types.Int64Null()
	} else {
		m.RateLimitOverride = types.Int64Value(*route.RateLimitOverride)
	}
	m.Retry = nil
	if route.Retry != nil {
		m.Retry = &retryModel{Attempts: types.Int64Value(route.Retry.Attempts), On: []types.Int64{}, Methods: []types.String{}}
		for _, code := range route.Retry.On {
			m.Retry.On = append(m.Retry.On, types.Int64Value(code))
		}
		for _, method := range route.Retry.Methods {
			m.Retry.Methods = append(m.Retry.Methods, types.StringValue(method))
		}
	}
	if len(route.Plugins) == 0 || string(route.Plugins) == "null" {
		m.Plugins = jsontypes.NewNormalizedNull()
	} else {
		m.Plugins = jsontypes.NewNormalizedValue(string(route.Plugins))
	}
	m.Portal = nil
	if route.Portal != nil {
		m.Portal = &portalModel{
			Visible:     types.BoolValue(route.Portal.Visible),
			Summary:     optionalString(route.Portal.Summary),
			Description: optionalString(route.Portal.Description),
		}
	}
}

func (r *routeResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan routeModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var created client.Route
	if err := r.client.Do(ctx, http.MethodPost, "/routes", plan.request(), &created); err != nil {
		addAPIError(&resp.Diagnostics, "Creating NovaGate route failed", err)
		return
	}
	plugins := plan.Plugins
	plan.refresh(&created)
	// Keep the configured spelling when the stored JSON is semantically equal.
	if equal, _ := plugins.StringSemanticEquals(ctx, plan.Plugins); equal {
		plan.Plugins = plugins
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *routeResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state routeModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	route, err := r.client.Route(ctx, state.ID.ValueString())
	if errors.Is(err, client.ErrNotFound) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		addAPIError(&resp.Diagnostics, "Reading NovaGate route failed", err)
		return
	}
	plugins := state.Plugins
	state.refresh(route)
	if equal, _ := plugins.StringSemanticEquals(ctx, state.Plugins); equal {
		state.Plugins = plugins
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *routeResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state routeModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := plan.request()
	var updated client.Route
	if err := r.client.Do(ctx, http.MethodPut, "/routes/"+state.ID.ValueString(), body, &updated); err != nil {
		addAPIError(&resp.Diagnostics, "Updating NovaGate route failed", err)
		return
	}
	plugins := plan.Plugins
	plan.refresh(&updated)
	if equal, _ := plugins.StringSemanticEquals(ctx, plan.Plugins); equal {
		plan.Plugins = plugins
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *routeResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state routeModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.Do(ctx, http.MethodDelete, "/routes/"+state.ID.ValueString(), nil, nil); err != nil && !errors.Is(err, client.ErrNotFound) {
		addAPIError(&resp.Diagnostics, "Deleting NovaGate route failed", err)
	}
}

func (r *routeResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
