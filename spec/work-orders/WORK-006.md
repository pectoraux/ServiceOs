# WORK-006

Status: in_flight
Owner: Architect
Architecture Version: v1.0
Assurance Profile: HIGH_ASSURANCE
Activation Issue: #58
Implementation Branch: `feat/WORK-006-event-inbox-outbox`
Activation Baseline: `23f6d604d9d43f32b89ab5781a28b74975465046`

## Objective

Implement the durable event inbox/outbox used by ServiceOS to react to external systems and dispatch outbound provider events safely.

## Dependencies

Requires: WORK-004, WORK-015
Enables: WORK-010

## Scope

Allowed:
- event ingestion
- durable inbox/outbox
- idempotent event consumers
- provider-independent event contracts

Forbidden:
- vertical-specific event meanings
- AI execution engine

## Protected Surfaces

event inbox/outbox, worker dispatch, callback ingestion

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- Inbound/outbound event processing is durable and idempotent; business modules do not call providers directly.

## Acceptance Criteria

- AC-1 Duplicate inbound events converge.
- AC-2 Outbound events are not silently lost after durable intent.
- AC-3 Event processing is isolated by tenant where applicable.
- AC-4 Zeck callbacks use the same durable ingestion guarantees.

## Verification Requirements

### Behavioral
- inbox/outbox lifecycle

### Structural
- no direct external calls from domain modules

### Discrimination / Mutation
- duplicate event regression

### Concurrency / Crash Safety
- two consumers of the same event do not produce duplicate domain effects
- crash between intent and dispatch converges

## Definition Of Done

See TEMPLATE.md.
