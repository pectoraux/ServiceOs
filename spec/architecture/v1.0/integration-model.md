# ServiceOS Integration Model

## Integration port principle

ServiceOS domain modules depend on provider-independent ports. Provider-specific SDKs stay in adapters.

## Initial integration categories

- Zeck
- email
- SMS
- voice/telephony
- accounting/ERP
- CRM
- construction management
- property management
- procurement
- payment
- document storage
- government portals

## Adapter rule

An adapter translates between an external system and a ServiceOS-owned contract. It does not own Service Work state.

## Inbound events

```text
External Provider
      ↓
Adapter/Webhook Boundary
      ↓
Validated Durable Inbox
      ↓
Idempotency Check
      ↓
Domain Event
      ↓
Workflow Engine
```

## Outbound effects

```text
Service Work
   ↓
Business policy
   ↓
Durable intent
   ↓
Provider adapter
   ↓
External effect
   ↓
Observed result
   ↓
Business evidence
```
