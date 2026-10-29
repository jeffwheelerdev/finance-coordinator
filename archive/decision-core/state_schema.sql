-- Proposed PostgreSQL persistence. NOT deployed. Provision only after the
-- hosting/database connection and any service costs have been reviewed.
CREATE TABLE IF NOT EXISTS finance_cycles (
  cycle_id text PRIMARY KEY,
  funding_execution_id uuid UNIQUE NOT NULL,
  status text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS finance_intents (
  intent_key text PRIMARY KEY,
  cycle_id text NOT NULL REFERENCES finance_cycles(cycle_id),
  stage text NOT NULL,
  idempotency_key uuid UNIQUE NOT NULL,
  state text NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents >= 0 AND amount_cents <= 250000),
  execution_id uuid,
  first_attempt_at timestamptz,
  completed_at timestamptz,
  UNIQUE(cycle_id, stage)
);
CREATE TABLE IF NOT EXISTS finance_webhook_inbox (
  event_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  resource_id uuid NOT NULL,
  processed_at timestamptz
);
-- Use atomic INSERT/transactions plus a database lock to claim work.
-- Storing a random idempotency key without uniqueness/atomic claiming is unsafe.
