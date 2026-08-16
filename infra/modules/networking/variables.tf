variable "project" {
  type = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "azs" {
  description = "Exactly 2 AZs -- RDS requires a subnet group spanning >=2 AZs even for a single-AZ instance."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "public_subnet_cidrs" {
  type    = list(string)
  default = ["10.20.0.0/24", "10.20.1.0/24"]
}

variable "private_subnet_cidrs" {
  type    = list(string)
  default = ["10.20.10.0/24", "10.20.11.0/24"]
}

variable "app_port" {
  description = "Port aexa-server listens on inside the container (PORT env var). Dockerfile EXPOSEs 5002, and the live VPS .env confirms PORT=5002 -- not the .env.example default of 5000."
  type        = number
  default     = 5002
}
