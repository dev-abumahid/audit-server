variable "project" {
  type    = string
  default = "aexa-ai"
}

variable "cluster_name" {
  description = "The shared aexa-server ECS cluster this service runs on."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "aexa_ai_sg_id" {
  type = string
}

variable "app_port" {
  type    = number
  default = 8000
}

variable "task_cpu" {
  description = "No Chromium/heavy runtime deps (unlike aexa-server) -- kept modest, revisit under real load."
  type        = number
  default     = 512
}

variable "task_memory" {
  type    = number
  default = 1024
}

variable "ecr_repository_url" {
  type = string
}

variable "app_secret_arn" {
  type = string
}

variable "ops_alerts_topic_arn" {
  type = string
}

variable "existing_namespace_id" {
  description = "Set if aexa-server's VPC already has a Cloud Map private DNS namespace -- avoids creating a second one. Check before applying."
  type        = string
  default     = null
}
