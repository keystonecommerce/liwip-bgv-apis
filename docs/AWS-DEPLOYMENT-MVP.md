# LIWIP BGV MVP — AWS Deployment

## Target architecture

```text
Internet
  -> HTTPS Application Load Balancer
     -> Worker Portal ECS/Fargate service (Next.js, port 3100)
     -> BGV Backend ECS/Fargate service (NestJS + BullMQ worker, port 3001)
        -> RDS PostgreSQL
        -> ElastiCache Redis
        -> Private S3 document bucket + KMS key
        -> Surepass and MSG91 over HTTPS
```

Use one backend task for the MVP because the BullMQ consumer and short-lived provider file buffers currently run inside the same NestJS process. Do not scale the backend above one task until verification workers load their input documents directly from S3.

## Deployment gate

- Local PostgreSQL and Redis are running.
- `npm run db:deploy`, backend smoke tests and the portal production build pass.
- The AWS CLI identity is an assumed IAM role in account `415407325762`, not root and not the separate learning account.
- The role can use ECR, ECS, IAM PassRole, CloudWatch, Secrets Manager, RDS, ElastiCache, EC2 networking, S3 and the project KMS key.

Verify the identity:

```powershell
aws sts get-caller-identity --profile liwip-bgv-role
```

The ARN must contain `assumed-role/`.

## Container images

```powershell
$AwsProfile = "liwip-bgv-role"
$AwsRegion = "ap-south-1"
$AwsAccount = "415407325762"
$Registry = "$AwsAccount.dkr.ecr.$AwsRegion.amazonaws.com"

aws ecr create-repository --repository-name liwip-bgv-backend --region $AwsRegion --profile $AwsProfile
aws ecr create-repository --repository-name liwip-bgv-worker-portal --region $AwsRegion --profile $AwsProfile

aws ecr get-login-password --region $AwsRegion --profile $AwsProfile |
  docker login --username AWS --password-stdin $Registry

docker build -t liwip-bgv-backend "C:\keystone\Gig Verfication\liwip-bgv-backend"
docker tag liwip-bgv-backend:latest "$Registry/liwip-bgv-backend:latest"
docker push "$Registry/liwip-bgv-backend:latest"

docker build -t liwip-bgv-worker-portal "C:\keystone\Gig Verfication\liwip-bgv-worker-portal"
docker tag liwip-bgv-worker-portal:latest "$Registry/liwip-bgv-worker-portal:latest"
docker push "$Registry/liwip-bgv-worker-portal:latest"
```

## Networking and managed data services

- Put ECS tasks, RDS and ElastiCache in private subnets across at least two Availability Zones.
- Give ECS outbound internet access through NAT so Surepass and MSG91 are reachable.
- Allow the load balancer to reach portal port `3100` and backend port `3001`.
- Allow only the backend security group to reach RDS port `5432` and Redis port `6379`.
- Do not expose RDS or Redis publicly.
- Configure an HTTPS listener and ACM certificate. Production worker sessions require HTTPS.

## Secrets Manager

Store these as secrets and inject them through the ECS task definition:

### Backend secrets

- `DATABASE_URL`
- `SUREPASS_BEARER_TOKEN`
- `SUREPASS_CUSTOMER_ID`, when required
- `MSG91_AUTHKEY`
- `MSG91_OTP_TEMPLATE_ID`
- `MSG91_SENDER_ID`
- `OTP_HASH_SECRET`
- the worker-portal API key created for the production client

### Worker portal secrets

- `VERIFICATION_API_KEY`
- `WORKER_SESSION_SECRET`
- `WORKER_PAYMENT_CODES`, while the MVP payment-code flow is enabled

## Backend environment

```env
NODE_ENV=production
PORT=3001
ENABLE_INTERNAL_ROUTES=false
REDIS_HOST=<elasticache-primary-endpoint>
REDIS_PORT=6379
AWS_REGION=ap-south-1
S3_DOCUMENT_BUCKET=liwip-bgv-documents-dev-a7x92
S3_DOCUMENT_KMS_KEY_ARN=<project-kms-key-arn>
S3_PRESIGNED_URL_EXPIRY_SECONDS=300
S3_TEMP_DOCUMENT_RETENTION_DAYS=30
S3_MAX_DOCUMENT_SIZE_BYTES=15728640
CORS_ORIGINS=https://<worker-portal-domain>
DIGILOCKER_REDIRECT_URL=https://<worker-portal-domain>/?digilocker=return
AADHAAR_OVSE_REDIRECT_URL=https://<worker-portal-domain>/?aadhaar=return
```

Do not set `AWS_PROFILE`, `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` in ECS. The AWS SDK receives credentials from the ECS task role.

## Worker portal environment

```env
NODE_ENV=production
PORT=3100
VERIFICATION_API_URL=https://<backend-domain>
BACKEND_WORKER_SUBMIT_PATH=/v1/worker-verifications
DIGILOCKER_REDIRECT_URL=https://<worker-portal-domain>/?digilocker=return
AADHAAR_OVSE_REDIRECT_URL=https://<worker-portal-domain>/?aadhaar=return
WORKER_PAYMENT_SPONSOR=<employer-name>
```

## IAM roles

Use two different ECS roles:

1. **Task execution role** — pull ECR images, write CloudWatch logs and read Secrets Manager values.
2. **Backend task role** — access only the LIWIP document bucket and project KMS key.

The backend task role needs the minimum required S3 object permissions and these KMS actions:

- `kms:Encrypt`
- `kms:Decrypt`
- `kms:GenerateDataKey`
- `kms:DescribeKey`

The portal task does not need S3 or KMS permissions because it obtains short-lived presigned URLs from the backend.

## S3 browser-upload CORS

After the worker domain is known, allow only that HTTPS origin:

```json
[
  {
    "AllowedOrigins": ["https://<worker-portal-domain>"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "x-amz-checksum-sha256"],
    "MaxAgeSeconds": 300
  }
]
```

Keep Block Public Access enabled. CORS does not make the bucket public.

## ECS services

- Create one ECS cluster using Fargate.
- Register a backend task definition using the backend ECR image, port `3001`, task/execution roles and backend secrets.
- Register a portal task definition using the portal ECR image, port `3100` and portal secrets.
- Create one service for each task definition.
- Use `/health` for the backend target-group health check.
- Use `/api/health` for the portal target-group health check.
- Start with desired count `1` for each service.

## Verification after deployment

1. Open the worker portal over HTTPS.
2. Send and verify a real OTP.
3. Submit one Basic ID application.
4. Confirm all uploaded files appear under the correct S3 tenant/client/application prefix.
5. Confirm PostgreSQL stores document references but not file bytes.
6. Resolve any manual checkpoints with a reviewer-only API key.
7. Confirm the final response becomes `PASS` and includes the generated LIWIP card.
8. Confirm the worker portal displays the card number and expiry date.
