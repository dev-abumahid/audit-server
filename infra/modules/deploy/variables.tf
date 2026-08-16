variable "project" {
  type = string
}

variable "github_repo" {
  description = "owner/repo, for scoping the OIDC trust policy sub condition."
  type        = string
  default     = "Qiyrix/aexa-server"
}

variable "github_branch" {
  type    = string
  default = "main"
}
