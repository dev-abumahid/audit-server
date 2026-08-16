variable "billing_alert_email" {
  description = "Email address subscribed to the billing-threshold SNS topic."
  type        = string
  default     = "omartakadoum@gmail.com"
}

variable "billing_alert_threshold_usd" {
  description = "Estimated monthly AWS charges (USD) above which the billing alarm fires."
  type        = number
  default     = 150
}
