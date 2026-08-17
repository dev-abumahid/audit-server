variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "ai_app_secrets" {
  description = "OPENAI_API_KEY, PINECONE_API_KEY, CLIENT_PINECONE_API_KEY, TAVILY_API_KEY -- copied from the VPS's live .env, no reason to rotate as part of an infra move. Supplied via terraform.auto.tfvars (gitignored)."
  type        = map(string)
  sensitive   = true
}
