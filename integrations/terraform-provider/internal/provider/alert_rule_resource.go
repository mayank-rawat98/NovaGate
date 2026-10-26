package provider

import (
	"context"
	"errors"
	"net/http"

	"github.com/hashicorp/terraform-plugin-framework-validators/float64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/mayank-rawat98/novagate/integrations/terraform-provider/internal/client"
)

var (
	_ resource.Resource                = &alertRuleResource{}
	_ resource.ResourceWithImportState = &alertRuleResource{}
)

type alertRuleResource struct{ client *client.Client }

type alertRuleModel struct {
	ID            types.String  `tfsdk:"id"`
	Name          types.String  `tfsdk:"name"`
	Metric        types.String  `tfsdk:"metric"`
	Operator      types.String  `tfsdk:"operator"`
	Threshold     types.Float64 `tfsdk:"threshold"`
	WindowMinutes types.Int64   `tfsdk:"window_minutes"`
	MinRequests   types.Int64   `tfsdk:"min_requests"`
	ChannelIDs    types.Set     `tfsdk:"channel_ids"`
	Enabled       types.Bool    `tfsdk:"enabled"`
	Revision      types.Int64   `tfsdk:"revision"`
}

func NewAlertRuleResource() resource.Resource { return &alertRuleResource{} }

func (r *alertRuleResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_alert_rule"
}

func toAttrValues[T attr.Value](values []T) []attr.Value {
	out := make([]attr.Value, len(values))
	for index, value := range values {
		out[index] = value
	}
	return out
}

func (r *alertRuleResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "An alert rule over recorded gateway metrics. Requires the alerts:write scope; delivery channels are managed in the dashboard because they hold credentials.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{Required: true, Validators: []validator.String{stringvalidator.LengthBetween(1, 100)}},
			"metric": schema.StringAttribute{
				Required:   true,
				Validators: []validator.String{stringvalidator.OneOf("error_rate", "p95_latency_ms", "rps", "downstream_timeout_rate")},
			},
			"operator": schema.StringAttribute{
				Required:   true,
				Validators: []validator.String{stringvalidator.OneOf(">", "<", ">=", "<=")},
			},
			"threshold": schema.Float64Attribute{
				Required:    true,
				Description: "Rates are fractions from 0 to 1; latency is milliseconds; rps is requests per second.",
				Validators:  []validator.Float64{float64validator.AtLeast(0)},
			},
			"window_minutes": schema.Int64Attribute{Required: true, Validators: []validator.Int64{int64validator.Between(1, 60)}},
			"min_requests": schema.Int64Attribute{
				Optional: true, Computed: true,
				Description:   "Requests required in the window before evaluating. Defaults to 1 (0 for rps).",
				Validators:    []validator.Int64{int64validator.Between(0, 1000000)},
				PlanModifiers: []planmodifier.Int64{int64planmodifier.UseStateForUnknown()},
			},
			"channel_ids": schema.SetAttribute{
				Optional: true, Computed: true, ElementType: types.StringType,
				Default:    setdefault.StaticValue(types.SetValueMust(types.StringType, nil)),
				Validators: []validator.Set{setvalidator.SizeAtMost(5)},
			},
			"enabled":  schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(true)},
			"revision": schema.Int64Attribute{Computed: true, Description: "Server revision used for optimistic concurrency."},
		},
	}
}

func (r *alertRuleResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (m *alertRuleModel) request(ctx context.Context) (map[string]any, bool) {
	channels := []string{}
	if diagnostics := m.ChannelIDs.ElementsAs(ctx, &channels, false); diagnostics.HasError() {
		return nil, false
	}
	body := map[string]any{
		"name":          m.Name.ValueString(),
		"metric":        m.Metric.ValueString(),
		"operator":      m.Operator.ValueString(),
		"threshold":     m.Threshold.ValueFloat64(),
		"windowMinutes": m.WindowMinutes.ValueInt64(),
		"channelIds":    channels,
		"enabled":       m.Enabled.ValueBool(),
	}
	if !m.MinRequests.IsNull() && !m.MinRequests.IsUnknown() {
		body["minRequests"] = m.MinRequests.ValueInt64()
	}
	return body, true
}

func (m *alertRuleModel) refresh(rule *client.AlertRule) {
	m.ID = types.StringValue(rule.ID)
	m.Name = types.StringValue(rule.Name)
	m.Metric = types.StringValue(rule.Metric)
	m.Operator = types.StringValue(rule.Operator)
	m.Threshold = types.Float64Value(rule.Threshold)
	m.WindowMinutes = types.Int64Value(rule.WindowMinutes)
	m.MinRequests = types.Int64Value(rule.MinRequests)
	channels := make([]types.String, len(rule.ChannelIDs))
	for index, id := range rule.ChannelIDs {
		channels[index] = types.StringValue(id)
	}
	m.ChannelIDs = types.SetValueMust(types.StringType, toAttrValues(channels))
	m.Enabled = types.BoolValue(rule.Enabled)
	m.Revision = types.Int64Value(rule.Revision)
}

func (r *alertRuleResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan alertRuleModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body, ok := plan.request(ctx)
	if !ok {
		resp.Diagnostics.AddError("Invalid channel_ids", "channel_ids must be a set of channel UUIDs")
		return
	}
	var created client.AlertRule
	if err := r.client.Do(ctx, http.MethodPost, "/alerts/rules", body, &created); err != nil {
		addAPIError(&resp.Diagnostics, "Creating NovaGate alert rule failed", err)
		return
	}
	plan.refresh(&created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *alertRuleResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state alertRuleModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	rule, err := r.client.AlertRule(ctx, state.ID.ValueString())
	if errors.Is(err, client.ErrNotFound) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		addAPIError(&resp.Diagnostics, "Reading NovaGate alert rule failed", err)
		return
	}
	state.refresh(rule)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *alertRuleResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state alertRuleModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body, ok := plan.request(ctx)
	if !ok {
		resp.Diagnostics.AddError("Invalid channel_ids", "channel_ids must be a set of channel UUIDs")
		return
	}
	// The refreshed revision rejects edits made elsewhere since the plan.
	body["revision"] = state.Revision.ValueInt64()
	var updated client.AlertRule
	if err := r.client.Do(ctx, http.MethodPut, "/alerts/rules/"+state.ID.ValueString(), body, &updated); err != nil {
		addAPIError(&resp.Diagnostics, "Updating NovaGate alert rule failed", err)
		return
	}
	plan.refresh(&updated)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *alertRuleResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state alertRuleModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := map[string]any{"revision": state.Revision.ValueInt64()}
	if err := r.client.Do(ctx, http.MethodDelete, "/alerts/rules/"+state.ID.ValueString(), body, nil); err != nil && !errors.Is(err, client.ErrNotFound) {
		addAPIError(&resp.Diagnostics, "Deleting NovaGate alert rule failed", err)
	}
}

func (r *alertRuleResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
