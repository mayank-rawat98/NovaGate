package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/mayank-rawat98/novagate/integrations/terraform-provider/internal/provider"
)

// version is set at release build time with -ldflags "-X main.version=…".
var version = "dev"

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run with support for debuggers such as delve")
	flag.Parse()
	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		Address: "registry.terraform.io/mayank-rawat98/novagate",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err)
	}
}
