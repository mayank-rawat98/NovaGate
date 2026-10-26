package provider

import (
	"context"
	"errors"
	"net/http"

	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/mayank-rawat98/novagate/integrations/terraform-provider/internal/client"
)

var (
	_ resource.Resource                = &consumerResource{}
	_ resource.ResourceWithImportState = &consumerResource{}
)

type consumerResource struct{ client *client.Client }

type consumerModel struct {
	ID            types.String `tfsdk:"id"`
	Name          types.String `tfsdk:"name"`
	RateLimitTier types.String `tfsdk:"rate_limit_tier"`
	Groups        types.Set    `tfsdk:"groups"`
	APIKey        types.String `tfsdk:"api_key"`
}

func NewConsumerResource() resource.Resource { return &consumerResource{} }

func (r *consumerResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_consumer"
}

func (r *consumerResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A gateway API consumer. Its key is returned once at creation and stored in state as a sensitive value. Destroy revokes the key. Requires the consumers:write scope.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:      true,
				Validators:    []validator.String{stringvalidator.LengthBetween(1, 128)},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"rate_limit_tier": schema.StringAttribute{
				Optional: true, Computed: true, Default: stringdefault.StaticString("authenticated"),
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"groups": schema.SetAttribute{
				Optional: true, Computed: true, ElementType: types.StringType,
				Default:     setdefault.StaticValue(types.SetValueMust(types.StringType, nil)),
				Validators:  []validator.Set{setvalidator.SizeAtMost(64)},
				Description: "Consumer groups used by the acl plugin.",
			},
			"api_key": schema.StringAttribute{
				Computed:      true,
				Sensitive:     true,
				Description:   "Gateway key (Authorization: Bearer …). Known only for consumers created by this configuration; imported consumers have none.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
		},
	}
}

func (r *consumerResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (m *consumerModel) groups(ctx context.Context) ([]string, bool) {
	groups := []string{}
	diagnostics := m.Groups.ElementsAs(ctx, &groups, false)
	return groups, !diagnostics.HasError()
}

func (m *consumerModel) refresh(consumer *client.Consumer) {
	m.ID = types.StringValue(consumer.ID)
	m.Name = types.StringValue(consumer.Name)
	m.RateLimitTier = types.StringValue(consumer.RateLimitTier)
	elements := make([]types.String, len(consumer.Groups))
	for index, group := range consumer.Groups {
		elements[index] = types.StringValue(group)
	}
	m.Groups = types.SetValueMust(types.StringType, toAttrValues(elements))
}

func (r *consumerResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan consumerModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	groups, ok := plan.groups(ctx)
	if !ok {
		resp.Diagnostics.AddError("Invalid groups", "groups must be a set of strings")
		return
	}
	var created client.Consumer
	body := map[string]any{"name": plan.Name.ValueString(), "rateLimitTier": plan.RateLimitTier.ValueString(), "groups": groups}
	if err := r.client.Do(ctx, http.MethodPost, "/consumers", body, &created); err != nil {
		addAPIError(&resp.Diagnostics, "Creating NovaGate consumer failed", err)
		return
	}
	plan.refresh(&created)
	plan.APIKey = types.StringValue(created.APIKey)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *consumerResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state consumerModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	consumer, err := r.client.Consumer(ctx, state.ID.ValueString())
	if errors.Is(err, client.ErrNotFound) {
		// Revoked consumers are not listed; recreate on the next apply.
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		addAPIError(&resp.Diagnostics, "Reading NovaGate consumer failed", err)
		return
	}
	state.refresh(consumer)
	if state.APIKey.IsUnknown() {
		state.APIKey = types.StringNull()
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *consumerResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state consumerModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	groups, ok := plan.groups(ctx)
	if !ok {
		resp.Diagnostics.AddError("Invalid groups", "groups must be a set of strings")
		return
	}
	var updated client.Consumer
	if err := r.client.Do(ctx, http.MethodPut, "/consumers/"+state.ID.ValueString(), map[string]any{"groups": groups}, &updated); err != nil {
		addAPIError(&resp.Diagnostics, "Updating NovaGate consumer failed", err)
		return
	}
	plan.refresh(&updated)
	plan.APIKey = state.APIKey
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *consumerResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state consumerModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.Do(ctx, http.MethodDelete, "/consumers/"+state.ID.ValueString(), nil, nil); err != nil && !errors.Is(err, client.ErrNotFound) {
		addAPIError(&resp.Diagnostics, "Revoking NovaGate consumer failed", err)
	}
}

func (r *consumerResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
