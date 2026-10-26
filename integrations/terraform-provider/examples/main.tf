terraform {
  required_providers {
    novagate = {
      source = "mayank-rawat98/novagate"
    }
  }
}

# Configure with NOVAGATE_API_URL, NOVAGATE_TENANT_ID and NOVAGATE_API_TOKEN.
provider "novagate" {}

data "novagate_tenant" "current" {}

resource "novagate_service" "users" {
  name = "users-api"
  targets = [
    { url = "https://users-a.internal.example", weight = 70 },
    { url = "https://users-b.internal.example", weight = 30 },
  ]
  load_balancing = "least-connections"
}

resource "novagate_route" "list_users" {
  method        = "GET"
  path_pattern  = "/users"
  service_id    = novagate_service.users.id
  auth_required = true
  retry         = { attempts = 2, on = [502, 503, 504], methods = ["GET"] }
  plugins = jsonencode([
    { name = "rate-limit", config = { max = 100, windowMs = 60000 } },
    { name = "acl", config = { allow = ["partners"] } },
  ])
  portal = {
    visible     = true
    summary     = "List users"
    description = "Returns users visible to the calling key."
  }
}

resource "novagate_consumer" "partner" {
  name   = "partner-app"
  groups = ["partners"]
}

resource "novagate_alert_rule" "errors" {
  name           = "High error rate"
  metric         = "error_rate"
  operator       = ">"
  threshold      = 0.05
  window_minutes = 5
}

output "partner_api_key" {
  value     = novagate_consumer.partner.api_key
  sensitive = true
}
