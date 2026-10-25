package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/mayank-rawat98/novagate/integrations/terraform-provider/internal/client"
)

var (
	_ datasource.DataSource = &tenantDataSource{}
	_ datasource.DataSource = &consumerDataSource{}
)

type tenantDataSource struct{ client *client.Client }

type tenantModel struct {
	ID                   types.String `tfsdk:"id"`
	Name                 types.String `tfsdk:"name"`
	PlanID               types.String `tfsdk:"plan_id"`
	GatewayConfigVersion types.Int64  `tfsdk:"gateway_config_version"`
}

func NewTenantDataSource() datasource.DataSource { return &tenantDataSource{} }

func (d *tenantDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_tenant"
}

func (d *tenantDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "The configured workspace. Requires the workspace:read scope.",
		Attributes: map[string]schema.Attribute{
			"id":                     schema.StringAttribute{Computed: true},
			"name":                   schema.StringAttribute{Computed: true},
			"plan_id":                schema.StringAttribute{Computed: true},
			"gateway_config_version": schema.Int64Attribute{Computed: true},
		},
	}
}

func (d *tenantDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (d *tenantDataSource) Read(ctx context.Context, _ datasource.ReadRequest, resp *datasource.ReadResponse) {
	tenant, err := d.client.TenantProfile(ctx)
	if err != nil {
		addAPIError(&resp.Diagnostics, "Reading NovaGate workspace failed", err)
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &tenantModel{
		ID:                   types.StringValue(tenant.ID),
		Name:                 types.StringValue(tenant.Name),
		PlanID:               types.StringValue(tenant.PlanID),
		GatewayConfigVersion: types.Int64Value(tenant.GatewayConfigVersion),
	})...)
}

type consumerDataSource struct{ client *client.Client }

type consumerLookupModel struct {
	ID            types.String `tfsdk:"id"`
	Name          types.String `tfsdk:"name"`
	RateLimitTier types.String `tfsdk:"rate_limit_tier"`
	Groups        types.Set    `tfsdk:"groups"`
}

func NewConsumerDataSource() datasource.DataSource { return &consumerDataSource{} }

func (d *consumerDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_consumer"
}

func (d *consumerDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Looks up an active consumer by exact name. Fails when no consumer or more than one matches. Requires the consumers:read scope.",
		Attributes: map[string]schema.Attribute{
			"name":            schema.StringAttribute{Required: true},
			"id":              schema.StringAttribute{Computed: true},
			"rate_limit_tier": schema.StringAttribute{Computed: true},
			"groups":          schema.SetAttribute{Computed: true, ElementType: types.StringType},
		},
	}
}

func (d *consumerDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (d *consumerDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var config consumerLookupModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	consumers, err := d.client.Consumers(ctx)
	if err != nil {
		addAPIError(&resp.Diagnostics, "Listing NovaGate consumers failed", err)
		return
	}
	var match *client.Consumer
	for index := range consumers {
		if consumers[index].Name != config.Name.ValueString() {
			continue
		}
		if match != nil {
			resp.Diagnostics.AddError("Ambiguous consumer name", "More than one active consumer has this name.")
			return
		}
		match = &consumers[index]
	}
	if match == nil {
		resp.Diagnostics.AddError("Consumer not found", "No active consumer has this name.")
		return
	}
	groups := make([]types.String, len(match.Groups))
	for index, group := range match.Groups {
		groups[index] = types.StringValue(group)
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &consumerLookupModel{
		ID:            types.StringValue(match.ID),
		Name:          types.StringValue(match.Name),
		RateLimitTier: types.StringValue(match.RateLimitTier),
		Groups:        types.SetValueMust(types.StringType, toAttrValues(groups)),
	})...)
}
