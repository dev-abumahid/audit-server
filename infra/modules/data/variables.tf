variable "project" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "db_security_group_id" {
  type = string
}

variable "redis_security_group_id" {
  type = string
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "postgres_version" {
  description = "Matches the version currently running on the VPS."
  type        = string
  default     = "16"
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}
