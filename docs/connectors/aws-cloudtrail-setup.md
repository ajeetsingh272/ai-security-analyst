# Connecting AWS CloudTrail (P7-02)

This is the customer-facing setup AC1 ("Cross-account role assumption with
an external id, documented for the customer") requires. It has two halves:
one you do once in your own AWS account, and one API call to tell Sentinel
about it. There is no OAuth consent screen for this connector — AWS's
cross-account role model has no third party to redirect your browser to.

## 1. Get your external id

```
GET /connectors/aws/external-id
```

(admin role required; same session cookie as every other authenticated
API call). Returns:

```json
{ "externalId": "a1b2c3..." }
```

This value is unique to your tenant and never changes. You need it for
step 2 below **before** you create the IAM role — Sentinel computes it
deterministically from your own tenant id (HMAC-SHA256, a fixed secret
only Sentinel's own servers hold), so reading it twice always returns the
same value; there is nothing to keep in sync between two separate reads.

## 2. Create the IAM role, in your own AWS account

Create an IAM role with:

- **Trust policy** — the principal is Sentinel's own AWS account (ask
  your Sentinel contact for the account id), and the trust condition
  requires the exact external id from step 1:

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": { "AWS": "arn:aws:iam::<sentinel-account-id>:root" },
        "Action": "sts:AssumeRole",
        "Condition": {
          "StringEquals": { "sts:ExternalId": "<externalId from step 1>" }
        }
      }
    ]
  }
  ```

  The external id is AWS's own documented mitigation for the
  "confused deputy" problem in cross-account role assumption — see
  [AWS's own guide](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html).
  Without it, anyone who ever learned your role ARN could ask Sentinel's
  account to assume it; with it, Sentinel's own AssumeRole call must also
  present the one external id that's unique to you.

- **Permissions policy** — read-only access to the one SQS queue
  CloudTrail events land in (see step 3):

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
        "Resource": "arn:aws:sqs:<region>:<your-account-id>:<queue-name>"
      }
    ]
  }
  ```

  Nothing broader than this is ever requested — Sentinel's connector
  reads and deletes messages from exactly this one queue, and does
  nothing else in your account at all.

## 3. Route CloudTrail into an SQS queue, via EventBridge

1. Create (or reuse) an SQS queue for this.
2. Create an EventBridge rule matching CloudTrail management events you
   want forwarded (e.g. `source: ["aws.cloudtrail"]`).
3. Add that SQS queue as the rule's target, with its **input
   transformer set to input path `$.detail`** — this is the one setting
   that matters most: it makes each SQS message body the *raw CloudTrail
   record* (`eventID`, `eventTime`, `eventName`, ...), not EventBridge's
   own wrapping envelope. Sentinel's connector expects the former.

## 4. Tell Sentinel

```
POST /connectors/aws/connect
Content-Type: application/json

{
  "roleArn": "arn:aws:iam::<your-account-id>:role/<role-name-from-step-2>",
  "region": "<region>",
  "queueUrl": "https://sqs.<region>.amazonaws.com/<your-account-id>/<queue-name>"
}
```

Sentinel re-derives your external id itself from your tenant id — it is
never read from this request body, so there is no way to submit the
wrong one by accident. The connector appears as "Connected" immediately
(matching every other connector's own optimistic-connect behaviour); if
the role turns out not to actually trust Sentinel's account (a typo in
the trust policy, the wrong external id, or the role was deleted), that
surfaces asynchronously as a degraded connector status on Sentinel's own
next scheduled attempt to use it — the same way any other connector's
health degrades, not as an error on this call itself (this call cannot,
by itself, prove the role is assumable without making a real
`sts:AssumeRole` call synchronously, which this endpoint deliberately
does not do).

## Disconnecting

```
POST /connectors/aws/revoke
```

Deletes Sentinel's own stored copy of your role ARN/external id/queue
URL immediately. It does **not** delete anything in your own AWS
account — your IAM role, its trust policy, the SQS queue, and the
EventBridge rule all remain exactly as you left them, for you to remove
or reuse as you choose.
