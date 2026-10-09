# Connecting Azure / Entra ID (P7-03)

This is the customer-facing setup AC4 ("documented with screenshots")
asks for. **Disclosed gap, prominently and up front, matching this
project's own standing disclosure discipline:** this document has no
actual screenshots in it — there is no Azure subscription or Entra
tenant available in this sandbox to click through and capture real ones
from. Every step below is accurate and complete against Microsoft's own
current documentation (verified while writing this, not recalled from
memory), with a `[Screenshot: ...]` marker at each point a real
walkthrough would show one. Replace those markers with real captures
against a live tenant before shipping this to an actual customer.

There is no OAuth consent screen for this connector, unlike M365/Google
— Event Hub consumption authenticates with a namespace-scoped SAS
connection string, not an Entra app registration (see
go/sentinelconnector/azure/credentials.go's own doc comment for why).

## 1. Route Entra ID logs to an Event Hub, via diagnostic settings

1. In the [Entra admin center](https://entra.microsoft.com), go to
   **Monitoring & health → Diagnostic settings**.
   `[Screenshot: the Diagnostic settings blade, empty, with "+ Add diagnostic setting" highlighted]`
2. Click **Add diagnostic setting**. Give it a name (e.g.
   `sentinel-export`).
3. Under **Logs**, enable at least:
   - **SignInLogs**
   - **AuditLogs**
   - **RiskyUsers** and/or **UserRiskEvents** (Identity Protection's own
     risk-detection categories — AC2's own requirement)
   `[Screenshot: the Logs checklist with these three/four categories checked]`
4. Under **Destination details**, choose **Stream to an event hub**.
   Select (or create) an Event Hubs **namespace**, and leave the event
   hub name field set to the default (Azure creates one event hub per
   enabled log category automatically) — or specify a single shared
   event hub name if you want every category multiplexed into one hub
   (go/sentinelconnector/azure's own MapEvent already branches on each
   record's own `category` field either way, so either layout works;
   one shared hub is simpler to configure here).
   `[Screenshot: the Destination details panel with "Stream to an event hub" selected and the namespace/event hub picker visible]`
5. Save. Entra ID typically takes a few minutes to start exporting.

## 2. Get the namespace's SAS connection string

1. In the [Azure portal](https://portal.azure.com), go to your Event
   Hubs **namespace** (not the individual event hub).
2. Go to **Settings → Shared access policies**.
   `[Screenshot: the Shared access policies list, showing RootManageSharedAccessKey]`
3. Either use the default `RootManageSharedAccessKey`, or — recommended,
   least privilege — create a new policy scoped to **Listen** only
   (Sentinel's connector only ever reads; AC1's own "read-only" spirit,
   matching every other connector in this product).
   `[Screenshot: "+ Add" policy dialog with only "Listen" checked]`
4. Click the policy, then copy the **Connection string–primary key**.
   It looks like:

   ```
   Endpoint=sb://<your-namespace>.servicebus.windows.net/;SharedAccessKeyName=<policy-name>;SharedAccessKey=<key>
   ```

## 3. Tell Sentinel

```
POST /connectors/azure/connect
Content-Type: application/json

{
  "connectionString": "Endpoint=sb://<your-namespace>.servicebus.windows.net/;SharedAccessKeyName=<policy-name>;SharedAccessKey=<key>",
  "eventHubName": "<the event hub name from step 1>"
}
```

(`consumerGroup` is optional — omit it to use the Event Hub's own
default `$Default` consumer group, which every Event Hub always has.)

The connector appears as "Connected" immediately; if the connection
string or event hub name turns out to be wrong, that surfaces
asynchronously as a degraded connector status on Sentinel's own next
scheduled attempt to use it — the same pattern every other connector's
own health already follows (see `docs/connectors/aws-cloudtrail-setup.md`
for the identical reasoning on the AWS side).

## Deduplication with Microsoft 365

If you have **also** connected Microsoft 365 (`docs` — M365's own setup,
not written here), both connectors read overlapping data for the same
Entra ID tenant: M365's own `Audit.AzureActiveDirectory` content and
this connector's `SignInLogs`/`AuditLogs` categories describe the SAME
underlying directory events through two different Microsoft export
paths. This is handled automatically — Sentinel recognises the overlap
and stores each real event once, regardless of which connector it
arrived through. You do not need to disable either connector to avoid
duplicate cases.

## Disconnecting

```
POST /connectors/azure/revoke
```

Deletes Sentinel's own stored copy of your connection string
immediately. It does **not** delete your diagnostic setting, Event Hub,
or namespace — those remain exactly as you left them in Azure.
