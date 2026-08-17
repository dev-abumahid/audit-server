variable "project" {
  description = "aexa-ai -- distinct from the shared ECS cluster name."
  type        = string
  default     = "aexa-ai"
}

variable "cluster_name" {
  description = "The shared aexa-server ECS cluster aexa-ai's service runs on."
  type        = string
}

variable "github_repo" {
  description = "owner/repo, for scoping the OIDC trust policy sub condition."
  type        = string
  default     = "Qiyrix/aexa-ai"
}

variable "github_branch" {
  type    = string
  default = "main"
}
