// Package provider implements the NovaGate Terraform provider.
package provider

import (
	"context"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/mayank-rawat98/novagate/integrations/terraform-provider/internal/client"
)

var _ provider.Provider = &novagateProvider{}

type novagateProvider struct{ version string }

type providerModel struct {
	APIURL   types.String `tfsdk:"api_url"`
	TenantID types.String `tfsdk:"tenant_id"`
	Token    types.String `tfsdk:"token"`
}

func New(version string) func() provider.Provider {
	return func() provider.Provider { return &novagateProvider{version: version} }
}

func (p *novagateProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "novagate"
	resp.Version = p.version
}

func (p *novagateProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manage NovaGate services, routes, consumers and alert rules through the admin API.",
		Attributes: map[string]schema.Attribute{
			"api_url": schema.StringAttribute{
				Optional:    true,
				Description: "Admin API base URL ending in /api, such as https://admin.example.com/api. Defaults to NOVAGATE_API_URL.",
			},
			"tenant_id": schema.StringAttribute{
				Optional:    true,
				Description: "Workspace UUID. Defaults to NOVAGATE_TENANT_ID.",
			},
			"token": schema.StringAttribute{
				Optional:    true,
				Sensitive:   true,
				Description: "Workspace automation token (ngat_…) with the scopes the configuration needs. Defaults to NOVAGATE_API_TOKEN.",
			},
		},
	}
}

func valueOrEnv(value types.String, name string) string {
	if !value.IsNull() && !value.IsUnknown() && value.ValueString() != "" {
		return value.ValueString()
	}
	return os.Getenv(name)
}

func (p *novagateProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var config providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if config.APIURL.IsUnknown() || config.TenantID.IsUnknown() || config.Token.IsUnknown() {
		resp.Diagnostics.AddError("Unknown provider configuration", "api_url, tenant_id and token must be known when the provider is configured.")
		return
	}
	apiClient, err := client.New(
		valueOrEnv(config.APIURL, "NOVAGATE_API_URL"),
		valueOrEnv(config.TenantID, "NOVAGATE_TENANT_ID"),
		valueOrEnv(config.Token, "NOVAGATE_API_TOKEN"),
	)
	if err != nil {
		resp.Diagnostics.AddError("Invalid NovaGate provider configuration", err.Error())
		return
	}
	resp.ResourceData = apiClient
	resp.DataSourceData = apiClient
}

func (p *novagateProvider) Resources(context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		NewServiceResource,
		NewRouteResource,
		NewConsumerResource,
		NewAlertRuleResource,
	}
}

func (p *novagateProvider) DataSources(context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		NewTenantDataSource,
		NewConsumerDataSource,
	}
}
