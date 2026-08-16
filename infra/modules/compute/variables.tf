variable "project" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "alb_sg_id" {
  type = string
}

variable "app_sg_id" {
  type = string
}

variable "app_port" {
  type = number
}

variable "alb_logs_bucket" {
  type = string
}

variable "ecr_repository_url" {
  type = string
}

variable "domain_name" {
  description = "Public DNS name the ALB will be reachable at."
  type        = string
  default     = "api.qiyrix.com"
}

variable "db_secret_arn" {
  type = string
}

variable "redis_secret_arn" {
  type = string
}

variable "app_secret_arn" {
  type = string
}

variable "aws_s3_secret_arn" {
  type = string
}

variable "task_cpu" {
  type    = number
  default = 512 # 0.5 vCPU, per plan
}

variable "task_memory" {
  type    = number
  default = 1024 # 1GB, per plan
}
