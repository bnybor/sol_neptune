#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 REGION EXPECTED_12_DIGIT_ACCOUNT_ID" >&2
  exit 2
fi

sol_region=$1
sol_expected_account=$2
sol_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
sol_project_dir=$(cd -- "$sol_script_dir/.." && pwd)

if command -v aws >/dev/null 2>&1; then
  sol_aws=$(command -v aws)
elif [[ -x "$sol_project_dir/.tooling/bin/aws" ]]; then
  sol_aws="$sol_project_dir/.tooling/bin/aws"
else
  cat >&2 <<'ERROR'
AWS CLI v2 was not found on PATH or at .tooling/bin/aws.
Install it locally with the official AWS installer, then authenticate before retrying.
ERROR
  exit 127
fi

if [[ ! $sol_region =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]]; then
  echo "Refusing ambiguous Region: $sol_region" >&2
  exit 2
fi

if [[ ! $sol_expected_account =~ ^[0-9]{12}$ ]]; then
  echo "Expected account ID must contain exactly 12 digits." >&2
  exit 2
fi

if ! sol_identity=$("$sol_aws" sts get-caller-identity \
  --region "$sol_region" \
  --query '[Account,Arn]' \
  --output text); then
  echo "STOP: AWS authentication failed; no deployment is permitted." >&2
  exit 5
fi

read -r sol_account sol_arn <<<"$sol_identity"

echo "AWS account ID: $sol_account"
echo "Caller identity: $sol_arn"
echo "Selected Region: $sol_region"

if [[ $sol_account != "$sol_expected_account" ]]; then
  echo "STOP: caller account does not match the explicitly expected account." >&2
  exit 3
fi

sol_instance_option_count=$("$sol_aws" neptune describe-orderable-db-instance-options \
  --region "$sol_region" \
  --engine neptune \
  --db-instance-class db.t4g.medium \
  --query 'length(OrderableDBInstanceOptions)' \
  --output text)

if [[ $sol_instance_option_count -eq 0 ]]; then
  echo "STOP: db.t4g.medium is not offered for Neptune in $sol_region." >&2
  exit 4
fi

"$sol_aws" neptune describe-db-engine-versions \
  --region "$sol_region" \
  --engine neptune \
  --default-only \
  --query 'DBEngineVersions[].{EngineVersion:EngineVersion,ParameterGroupFamily:DBParameterGroupFamily}' \
  --output table

cat <<'RESOURCES'
Resources proposed for the dedicated stack:
- 1 VPC with exactly 2 isolated subnets and 2 local-only route tables
- 2 security groups
- 1 encrypted, IAM-authenticated Neptune cluster
- exactly 1 db.t4g.medium Neptune writer and 0 readers
- 1 public non-VPC MCP Lambda Function URL
- 1 private VPC executor Lambda
- 2 CloudWatch log groups retained for 14 days
- no NAT Gateway, Internet Gateway, load balancer, API Gateway, EC2, or Fargate

Estimated recurring cost in us-east-1 (price snapshot 2026-09-21):
- db.t4g.medium: $0.093/hour, about $67.89 for 730 hours
- storage: $0.10/GB-month
- backup storage beyond the free allocation: $0.021/GB-month
- standard storage I/O: $0.20 per million requests
- Lambda and logs: request-driven usage; normally small, but not guaranteed to be zero

No deployment was performed by this preflight.
RESOURCES
