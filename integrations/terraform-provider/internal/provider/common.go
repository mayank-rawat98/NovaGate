package provider

import (
	"errors"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/diag"

	"github.com/mayank-rawat98/novagate/integrations/terraform-provider/internal/client"
)

// configuredClient extracts the provider's API client from Configure data.
// Data is nil during validation-only calls, which is not an error.
func configuredClient(data any, diagnostics *diag.Diagnostics) *client.Client {
	if data == nil {
		return nil
	}
	apiClient, ok := data.(*client.Client)
	if !ok {
		diagnostics.AddError("Unexpected provider data", fmt.Sprintf("expected *client.Client, got %T", data))
		return nil
	}
	return apiClient
}

func addAPIError(diagnostics *diag.Diagnostics, action string, err error) {
	var apiError *client.APIError
	if errors.As(err, &apiError) && apiError.Status == 403 {
		diagnostics.AddError(action, err.Error()+". Check that the automation token has the scope for this resource.")
		return
	}
	diagnostics.AddError(action, err.Error())
}
