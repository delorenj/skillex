---
name: bub-email-triage
description: Canonical workflow for Bub inbox/calendar triage and escalation filtering.
---

# Bub Email & Calendar Triage

## Escalate only if one applies
1. Known-contact actionable request
2. Money/risk/security impact
3. High-signal AI/platform update with concrete operational impact

## Default
- Suppress promo/newsletter noise
- Silent discard when non-actionable

## Escalation target
- `agent:main:main`

## Escalation format
```text
📧 [CRITICAL] From: {sender}
Subject: {subject}
Category: {contact|money|security|ai-news}
Summary: {1-2 lines}
Action needed: {next step}
```

## Standing responsibility
- Every Gmail thread/email tagged `Ava` (sent + received) must be exported to Markdown and synced under:
  `/home/delorenj/d/Family/Ava/`
