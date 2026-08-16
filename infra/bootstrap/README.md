# Bootstrap

Creates the S3 bucket + DynamoDB table that `infra/environments/prod` uses as
its remote state backend, plus the billing alarm. Run this once, before
anything else in `infra/`.

This module's own state is **local** (`terraform.tfstate` in this directory,
gitignored) -- a remote backend can't bootstrap itself. If this state file is
ever lost, the resources it created (state bucket, lock table, billing alarm)
can be re-imported; they're not meant to change often after initial creation.

## One-time manual step (console only, no Terraform/API for this)

Billing alarms require **"Receive Billing Alerts"** to be enabled under
Billing preferences in the account root/management console
(Billing and Cost Management -> Billing preferences -> Alert preferences).
This is an account-level checkbox with no Terraform resource or CLI
equivalent -- enable it before `terraform apply`, or the
`aws_cloudwatch_metric_alarm.billing` resource will apply successfully but
never actually fire.

## Usage

```
cd infra/bootstrap
terraform init
terraform apply
```

Confirm the SNS email subscription (check your inbox) after applying, or the
billing alarm will fire into a topic with no confirmed subscriber.
